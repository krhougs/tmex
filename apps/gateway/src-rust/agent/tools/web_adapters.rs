use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use serde_json::Value;

use crate::agent::AgentPortError;
use crate::crypto::{CryptoContext, MasterKey};
use crate::database::repository::Repository;

use super::{
    resolve_fetch_target, AgentDnsResolver, AgentWebHttpTransport, AgentWebSearch,
    ResolvedWebTarget, TokioDnsResolver, WebHttpMethod, WebHttpRequest, WebHttpResponse,
    WebSearchResultItem, FETCH_URL_TIMEOUT, WEB_SEARCH_MAX_RESULTS,
};

const WEB_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const WEB_SEARCH_RESPONSE_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";
const BRAVE_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";

#[derive(Clone)]
pub struct ReqwestAgentWebHttpTransport {
    connect_timeout: Duration,
}

impl ReqwestAgentWebHttpTransport {
    pub fn new(connect_timeout: Duration) -> Self {
        Self { connect_timeout }
    }
}

impl Default for ReqwestAgentWebHttpTransport {
    fn default() -> Self {
        Self::new(WEB_CONNECT_TIMEOUT)
    }
}

impl fmt::Debug for ReqwestAgentWebHttpTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReqwestAgentWebHttpTransport")
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

#[async_trait]
impl AgentWebHttpTransport for ReqwestAgentWebHttpTransport {
    async fn send(&self, request: WebHttpRequest) -> Result<WebHttpResponse, AgentPortError> {
        let host = request
            .target
            .url
            .host_str()
            .ok_or_else(|| AgentPortError::new("web request target has no host"))?
            .to_owned();
        let port = request
            .target
            .url
            .port_or_known_default()
            .ok_or_else(|| AgentPortError::new("web request target has no port"))?;
        if !matches!(request.target.url.scheme(), "http" | "https") {
            return Err(AgentPortError::new("web request protocol is not supported"));
        }
        if request.target.resolved_ips.is_empty() {
            return Err(AgentPortError::new(
                "web request target has no resolved addresses",
            ));
        }
        let addresses = request
            .target
            .resolved_ips
            .iter()
            .copied()
            .map(|ip| SocketAddr::new(ip, port))
            .collect::<Vec<_>>();
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .referer(false)
            .no_proxy()
            .connect_timeout(self.connect_timeout)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| AgentPortError::new("failed to build web HTTP client"))?;
        let method = match request.method {
            WebHttpMethod::Get => reqwest::Method::GET,
            WebHttpMethod::Post => reqwest::Method::POST,
        };
        let mut builder = client
            .request(method, request.target.url)
            .timeout(request.timeout);
        for (name, value) in request.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| AgentPortError::new("invalid web request header name"))?;
            let value = HeaderValue::from_str(&value)
                .map_err(|_| AgentPortError::new("invalid web request header value"))?;
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let mut response = builder.send().await.map_err(reqwest_error)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let mut body = Vec::with_capacity(request.max_body_bytes.min(64 * 1024));
        while body.len() < request.max_body_bytes {
            let Some(chunk) = response.chunk().await.map_err(reqwest_error)? else {
                break;
            };
            let remaining = request.max_body_bytes - body.len();
            body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if chunk.len() >= remaining {
                break;
            }
        }
        Ok(WebHttpResponse {
            status,
            headers,
            body,
        })
    }
}

fn reqwest_error(error: reqwest::Error) -> AgentPortError {
    let message = if error.is_timeout() {
        "web request timed out"
    } else if error.is_connect() {
        "web request connection failed"
    } else if error.is_builder() {
        "web request is invalid"
    } else {
        "web request failed"
    };
    AgentPortError::new(message)
}

#[derive(Clone)]
pub struct RepositoryAgentWebSearch {
    repository: Repository,
    master_key: MasterKey,
    resolver: Arc<dyn AgentDnsResolver>,
    transport: Arc<dyn AgentWebHttpTransport>,
    tavily_endpoint: String,
    brave_endpoint: String,
}

impl RepositoryAgentWebSearch {
    pub fn new(repository: Repository, master_key: MasterKey) -> Self {
        Self::with_ports(
            repository,
            master_key,
            Arc::new(TokioDnsResolver),
            Arc::new(ReqwestAgentWebHttpTransport::default()),
        )
    }

    pub fn with_ports(
        repository: Repository,
        master_key: MasterKey,
        resolver: Arc<dyn AgentDnsResolver>,
        transport: Arc<dyn AgentWebHttpTransport>,
    ) -> Self {
        Self {
            repository,
            master_key,
            resolver,
            transport,
            tavily_endpoint: TAVILY_ENDPOINT.to_owned(),
            brave_endpoint: BRAVE_ENDPOINT.to_owned(),
        }
    }

    #[cfg(test)]
    fn with_endpoints(mut self, tavily_endpoint: String, brave_endpoint: String) -> Self {
        self.tavily_endpoint = tavily_endpoint;
        self.brave_endpoint = brave_endpoint;
        self
    }

    async fn settings(&self) -> Result<crate::entity::agent_settings::Model, AgentPortError> {
        self.repository
            .get_agent_settings()
            .await
            .map_err(|_| AgentPortError::new("failed to load web search settings"))
    }

    fn decrypt_key(
        &self,
        settings: &crate::entity::agent_settings::Model,
        field: &'static str,
        ciphertext: Option<&str>,
    ) -> Result<String, AgentPortError> {
        let ciphertext = ciphertext
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AgentPortError::new("web search is not configured"))?;
        self.master_key
            .decrypt_with_context(
                ciphertext,
                CryptoContext::new("agent_settings")
                    .entity_id(settings.id.to_string())
                    .field(field),
            )
            .map_err(|error| AgentPortError::new(error.to_string()))
    }

    async fn resolve_endpoint(&self, endpoint: &str) -> Result<ResolvedWebTarget, AgentPortError> {
        resolve_fetch_target(endpoint, false, self.resolver.as_ref())
            .await
            .map_err(|error| AgentPortError::new(error.to_string()))
    }

    async fn search_tavily(
        &self,
        query: &str,
        max_results: usize,
        settings: &crate::entity::agent_settings::Model,
    ) -> Result<Vec<WebSearchResultItem>, AgentPortError> {
        let key = self.decrypt_key(
            settings,
            "tavily_api_key_enc",
            settings.tavily_api_key_enc.as_deref(),
        )?;
        let target = self.resolve_endpoint(&self.tavily_endpoint).await?;
        let body = serde_json::to_vec(&serde_json::json!({
            "api_key": key,
            "query": query,
            "max_results": max_results.min(WEB_SEARCH_MAX_RESULTS),
        }))
        .map_err(|_| AgentPortError::new("failed to encode Tavily search request"))?;
        let response = self
            .transport
            .send(WebHttpRequest {
                method: WebHttpMethod::Post,
                target,
                timeout: FETCH_URL_TIMEOUT,
                max_body_bytes: WEB_SEARCH_RESPONSE_MAX_BODY_BYTES,
                headers: BTreeMap::from([
                    ("Content-Type".to_owned(), "application/json".to_owned()),
                    ("Authorization".to_owned(), format!("Bearer {key}")),
                ]),
                body,
            })
            .await
            .map_err(|_| AgentPortError::new("Tavily search failed: request failed"))?;
        if !(200..300).contains(&response.status) {
            return Err(AgentPortError::new(format!(
                "Tavily search failed: HTTP {}",
                response.status
            )));
        }
        let payload = serde_json::from_slice::<Value>(&response.body)
            .map_err(|_| AgentPortError::new("Tavily search returned invalid JSON"))?;
        parse_results(
            payload.get("results"),
            "content",
            "Tavily search returned invalid results",
        )
    }

    async fn search_brave(
        &self,
        query: &str,
        max_results: usize,
        settings: &crate::entity::agent_settings::Model,
    ) -> Result<Vec<WebSearchResultItem>, AgentPortError> {
        let key = self.decrypt_key(
            settings,
            "brave_api_key_enc",
            settings.brave_api_key_enc.as_deref(),
        )?;
        let mut endpoint = reqwest::Url::parse(&self.brave_endpoint)
            .map_err(|_| AgentPortError::new("Brave search endpoint is invalid"))?;
        endpoint
            .query_pairs_mut()
            .append_pair("q", query)
            .append_pair(
                "count",
                &max_results.min(WEB_SEARCH_MAX_RESULTS).to_string(),
            );
        let target = self.resolve_endpoint(endpoint.as_str()).await?;
        let response = self
            .transport
            .send(WebHttpRequest {
                method: WebHttpMethod::Get,
                target,
                timeout: FETCH_URL_TIMEOUT,
                max_body_bytes: WEB_SEARCH_RESPONSE_MAX_BODY_BYTES,
                headers: BTreeMap::from([
                    ("Accept".to_owned(), "application/json".to_owned()),
                    ("X-Subscription-Token".to_owned(), key),
                ]),
                body: Vec::new(),
            })
            .await
            .map_err(|_| AgentPortError::new("Brave search failed: request failed"))?;
        if !(200..300).contains(&response.status) {
            return Err(AgentPortError::new(format!(
                "Brave search failed: HTTP {}",
                response.status
            )));
        }
        let payload = serde_json::from_slice::<Value>(&response.body)
            .map_err(|_| AgentPortError::new("Brave search returned invalid JSON"))?;
        parse_results(
            payload.get("web").and_then(|web| web.get("results")),
            "description",
            "Brave search returned invalid results",
        )
    }
}

impl fmt::Debug for RepositoryAgentWebSearch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RepositoryAgentWebSearch(..)")
    }
}

#[async_trait]
impl AgentWebSearch for RepositoryAgentWebSearch {
    async fn is_configured(&self) -> Result<bool, AgentPortError> {
        let settings = self.settings().await?;
        let configured = match settings.search_provider.as_str() {
            "tavily" => has_ciphertext(settings.tavily_api_key_enc.as_deref()),
            "brave" => has_ciphertext(settings.brave_api_key_enc.as_deref()),
            _ => false,
        };
        Ok(configured)
    }

    async fn search(
        &self,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<WebSearchResultItem>, AgentPortError> {
        let settings = self.settings().await?;
        match settings.search_provider.as_str() {
            "tavily" => self.search_tavily(query, max_results, &settings).await,
            "brave" => self.search_brave(query, max_results, &settings).await,
            _ => Err(AgentPortError::new("web search is not configured")),
        }
    }
}

fn has_ciphertext(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn parse_results(
    results: Option<&Value>,
    snippet_field: &str,
    invalid_message: &'static str,
) -> Result<Vec<WebSearchResultItem>, AgentPortError> {
    let Some(results) = results else {
        return Ok(Vec::new());
    };
    let results = results
        .as_array()
        .ok_or_else(|| AgentPortError::new(invalid_message))?;
    Ok(results
        .iter()
        .map(|item| WebSearchResultItem {
            title: string_field(item, "title"),
            url: string_field(item, "url"),
            snippet: string_field(item, snippet_field),
        })
        .collect())
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::database::repository::AgentSettingsUpdate;
    use crate::database::DatabaseBootstrap;
    use tmex_db::DbConfig;

    use super::*;

    struct PublicResolver;

    #[async_trait]
    impl AgentDnsResolver for PublicResolver {
        async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, AgentPortError> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))])
        }
    }

    #[derive(Default)]
    struct RecordingTransport {
        requests: Mutex<Vec<WebHttpRequest>>,
        responses: Mutex<VecDeque<Result<WebHttpResponse, AgentPortError>>>,
    }

    #[async_trait]
    impl AgentWebHttpTransport for RecordingTransport {
        async fn send(&self, request: WebHttpRequest) -> Result<WebHttpResponse, AgentPortError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(AgentPortError::new("missing fake response")))
        }
    }

    #[tokio::test]
    async fn repository_search_tracks_settings_and_keeps_credentials_out_of_diagnostics() {
        const TAVILY_KEY: &str = "tavily-plaintext-marker";
        const BRAVE_KEY: &str = "brave-plaintext-marker";

        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .unwrap();
        let repository = Repository::new(database);
        let master_key = MasterKey::development_default();
        let tavily_ciphertext = master_key.encrypt(TAVILY_KEY).unwrap();
        let brave_ciphertext = master_key.encrypt(BRAVE_KEY).unwrap();
        let transport = Arc::new(RecordingTransport::default());
        let search = RepositoryAgentWebSearch::with_ports(
            repository.clone(),
            master_key,
            Arc::new(PublicResolver),
            transport.clone(),
        )
        .with_endpoints(
            "https://tavily.test/search".to_owned(),
            "https://brave.test/search".to_owned(),
        );

        assert!(!search.is_configured().await.unwrap());
        repository
            .update_agent_settings(AgentSettingsUpdate {
                search_provider: Some("tavily".to_owned()),
                tavily_api_key_enc: Some(Some(tavily_ciphertext.clone())),
                ..AgentSettingsUpdate::default()
            })
            .await
            .unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Ok(WebHttpResponse {
                status: 200,
                headers: BTreeMap::new(),
                body: br#"{"results":[{"title":"T","url":"https://t","content":"S"}]}"#.to_vec(),
            }));
        assert!(search.is_configured().await.unwrap());
        assert_eq!(
            search.search("tmux", WEB_SEARCH_MAX_RESULTS).await.unwrap(),
            vec![WebSearchResultItem {
                title: "T".to_owned(),
                url: "https://t".to_owned(),
                snippet: "S".to_owned(),
            }]
        );

        repository
            .update_agent_settings(AgentSettingsUpdate {
                search_provider: Some("brave".to_owned()),
                brave_api_key_enc: Some(Some(brave_ciphertext.clone())),
                ..AgentSettingsUpdate::default()
            })
            .await
            .unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Ok(WebHttpResponse {
                status: 200,
                headers: BTreeMap::new(),
                body: br#"{"web":{"results":[{"title":"B","url":"https://b","description":"D"}]}}"#
                    .to_vec(),
            }));
        assert!(search.is_configured().await.unwrap());
        assert_eq!(search.search("rust dns", 4).await.unwrap()[0].title, "B");

        {
            let requests = transport.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].method, WebHttpMethod::Post);
            assert_eq!(requests[1].method, WebHttpMethod::Get);
            assert_eq!(
                requests[0].headers.get("Authorization").map(String::as_str),
                Some("Bearer tavily-plaintext-marker")
            );
            let tavily_body = serde_json::from_slice::<Value>(&requests[0].body).unwrap();
            assert_eq!(tavily_body["api_key"], TAVILY_KEY);
            assert_eq!(tavily_body["query"], "tmux");
            assert_eq!(tavily_body["max_results"], WEB_SEARCH_MAX_RESULTS);
            assert_eq!(
                requests[1]
                    .headers
                    .get("X-Subscription-Token")
                    .map(String::as_str),
                Some(BRAVE_KEY)
            );
            assert_eq!(
                requests[1]
                    .target
                    .url
                    .query_pairs()
                    .collect::<BTreeMap<_, _>>(),
                BTreeMap::from([
                    ("count".into(), "4".into()),
                    ("q".into(), "rust dns".into())
                ])
            );
            for (request, plaintext, ciphertext) in [
                (&requests[0], TAVILY_KEY, tavily_ciphertext.as_str()),
                (&requests[1], BRAVE_KEY, brave_ciphertext.as_str()),
            ] {
                let debug = format!("{request:?}");
                assert!(!debug.contains(plaintext));
                assert!(!debug.contains(ciphertext));
            }
        }

        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Err(AgentPortError::new(format!(
                "transport exposed {BRAVE_KEY} {brave_ciphertext}"
            ))));
        let error = search.search("failure", 1).await.unwrap_err();
        assert!(!error.to_string().contains(BRAVE_KEY));
        assert!(!error.to_string().contains(&brave_ciphertext));
    }

    #[tokio::test]
    async fn reqwest_transport_pins_dns_and_does_not_follow_redirects() {
        let (address, request_text) = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        )
        .await;
        let response = ReqwestAgentWebHttpTransport::default()
            .send(WebHttpRequest {
                method: WebHttpMethod::Get,
                target: ResolvedWebTarget {
                    url: reqwest::Url::parse(&format!(
                        "http://dns-pin.invalid:{}/path",
                        address.port()
                    ))
                    .unwrap(),
                    resolved_ips: vec![address.ip()],
                },
                timeout: Duration::from_secs(2),
                max_body_bytes: 16,
                headers: BTreeMap::new(),
                body: Vec::new(),
            })
            .await
            .unwrap();
        assert_eq!(response.status, 302);
        let request_text = request_text.await.unwrap();
        let normalized_request = request_text.to_ascii_lowercase();
        assert!(
            normalized_request.contains(&format!("host: dns-pin.invalid:{}", address.port())),
            "unexpected pinned request: {request_text:?}"
        );
    }

    #[tokio::test]
    async fn reqwest_transport_bounds_body_and_redacts_response_debug() {
        const BODY: &str = "response-secret-marker-that-is-too-long";
        let response_bytes = format!(
            "HTTP/1.1 200 OK\r\nX-Secret: response-header-marker\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
            BODY.len()
        )
        .into_bytes();
        let (address, _request_text) = serve_once(response_bytes).await;
        let response = ReqwestAgentWebHttpTransport::default()
            .send(WebHttpRequest {
                method: WebHttpMethod::Get,
                target: ResolvedWebTarget {
                    url: reqwest::Url::parse(&format!(
                        "http://body-limit.invalid:{}/",
                        address.port()
                    ))
                    .unwrap(),
                    resolved_ips: vec![address.ip()],
                },
                timeout: Duration::from_secs(2),
                max_body_bytes: 8,
                headers: BTreeMap::new(),
                body: Vec::new(),
            })
            .await
            .unwrap();
        assert_eq!(response.body, &BODY.as_bytes()[..8]);
        let debug = format!("{response:?}");
        assert!(!debug.contains("response-secret-marker"));
        assert!(!debug.contains("response-header-marker"));
    }

    async fn serve_once(response: Vec<u8>) -> (SocketAddr, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = request_tx.send(String::from_utf8_lossy(&request).into_owned());
            stream.write_all(&response).await.unwrap();
        });
        (address, request_rx)
    }
}
