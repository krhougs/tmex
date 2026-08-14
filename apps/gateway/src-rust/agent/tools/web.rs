use std::collections::BTreeMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use reqwest::Url;

use super::{wrap_untrusted, UntrustedContentKind};
use crate::agent::{redact_secrets, AgentPortError};

pub const WEB_SEARCH_MAX_RESULTS: usize = 8;
pub const WEB_SEARCH_RESULT_MAX_BYTES: usize = 8 * 1024;
pub const FETCH_URL_TIMEOUT: Duration = Duration::from_secs(15);
pub const FETCH_URL_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const FETCH_URL_TEXT_MAX_BYTES: usize = 16 * 1024;
pub const FETCH_URL_MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebSearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[async_trait]
pub trait AgentWebSearch: Send + Sync {
    async fn is_configured(&self) -> Result<bool, AgentPortError> {
        Ok(true)
    }

    async fn search(
        &self,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<WebSearchResultItem>, AgentPortError>;
}

#[async_trait]
pub trait AgentDnsResolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, AgentPortError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TokioDnsResolver;

#[async_trait]
impl AgentDnsResolver for TokioDnsResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, AgentPortError> {
        let addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|error| AgentPortError::new(format!("DNS resolution failed: {error}")))?;
        let mut ips = addresses.map(|address| address.ip()).collect::<Vec<_>>();
        ips.sort();
        ips.dedup();
        Ok(ips)
    }
}

#[derive(Clone)]
pub struct ResolvedWebTarget {
    pub url: Url,
    pub resolved_ips: Vec<IpAddr>,
}

impl fmt::Debug for ResolvedWebTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedWebTarget")
            .field("scheme", &self.url.scheme())
            .field("host", &self.url.host_str())
            .field("port", &self.url.port_or_known_default())
            .field("resolved_ips", &self.resolved_ips)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebHttpMethod {
    Get,
    Post,
}

#[derive(Clone)]
pub struct WebHttpRequest {
    pub method: WebHttpMethod,
    pub target: ResolvedWebTarget,
    pub timeout: Duration,
    pub max_body_bytes: usize,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl fmt::Debug for WebHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebHttpRequest")
            .field("method", &self.method)
            .field("target", &self.target)
            .field("timeout", &self.timeout)
            .field("max_body_bytes", &self.max_body_bytes)
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .field("body_len", &self.body.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebHttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl fmt::Debug for WebHttpResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebHttpResponse")
            .field("status", &self.status)
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .field("body_len", &self.body.len())
            .finish()
    }
}

#[async_trait]
pub trait AgentWebHttpTransport: Send + Sync {
    /// Implementations must disable automatic redirects and connect only to one of
    /// `request.target.resolved_ips`; resolving the hostname again would reopen DNS rebinding.
    async fn send(&self, request: WebHttpRequest) -> Result<WebHttpResponse, AgentPortError>;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FetchUrlPolicyError {
    #[error("invalid URL")]
    InvalidUrl,
    #[error("unsupported protocol: {0} (only http/https are allowed)")]
    UnsupportedProtocol(String),
    #[error("URLs containing credentials are not allowed")]
    EmbeddedCredentials,
    #[error("refusing to fetch private/internal address: {0}")]
    PrivateAddress(String),
    #[error("DNS resolution returned no addresses")]
    EmptyDnsResult,
    #[error(transparent)]
    Resolver(#[from] AgentPortError),
}

fn normalize_hostname(hostname: &str) -> String {
    hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

fn is_canonical_ipv4(host: &str) -> bool {
    let parts = host.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && (part == &"0" || !part.starts_with('0'))
                && part.parse::<u8>().is_ok()
        })
}

fn is_numeric_host(host: &str) -> bool {
    let parts = host.split('.').collect::<Vec<_>>();
    !parts.is_empty()
        && parts.len() <= 4
        && parts.iter().all(|part| {
            let decimal = !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
            let hexadecimal = part.strip_prefix("0x").is_some_and(|value| {
                !value.is_empty() && value.bytes().all(|b| b.is_ascii_hexdigit())
            });
            decimal || hexadecimal
        })
}

pub fn is_private_hostname(hostname: &str) -> bool {
    let host = normalize_hostname(hostname);
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_or_internal_ip(ip);
    }
    if is_canonical_ipv4(&host) {
        return host
            .parse::<Ipv4Addr>()
            .map(IpAddr::V4)
            .is_ok_and(is_private_or_internal_ip);
    }
    is_numeric_host(&host)
}

pub fn is_private_or_internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || a >= 224
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_unspecified()
                || ip.is_loopback()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xff00) == 0xff00
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ip| is_private_or_internal_ip(IpAddr::V4(ip)))
        }
    }
}

pub fn validate_fetch_url(raw_url: &str, allow_private: bool) -> Result<Url, FetchUrlPolicyError> {
    let url = Url::parse(raw_url).map_err(|_| FetchUrlPolicyError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchUrlPolicyError::UnsupportedProtocol(
            url.scheme().to_owned(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchUrlPolicyError::EmbeddedCredentials);
    }
    let host = url.host_str().ok_or(FetchUrlPolicyError::InvalidUrl)?;
    if !allow_private && is_private_hostname(host) {
        return Err(FetchUrlPolicyError::PrivateAddress(host.to_owned()));
    }
    Ok(url)
}

pub async fn resolve_fetch_target(
    raw_url: &str,
    allow_private: bool,
    resolver: &dyn AgentDnsResolver,
) -> Result<ResolvedWebTarget, FetchUrlPolicyError> {
    let url = validate_fetch_url(raw_url, allow_private)?;
    let host = url.host_str().ok_or(FetchUrlPolicyError::InvalidUrl)?;
    let port = url
        .port_or_known_default()
        .ok_or(FetchUrlPolicyError::InvalidUrl)?;
    let resolved_ips = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => resolver.resolve(host, port).await?,
    };
    if resolved_ips.is_empty() {
        return Err(FetchUrlPolicyError::EmptyDnsResult);
    }
    if !allow_private {
        if let Some(ip) = resolved_ips
            .iter()
            .copied()
            .find(|ip| is_private_or_internal_ip(*ip))
        {
            return Err(FetchUrlPolicyError::PrivateAddress(ip.to_string()));
        }
    }
    Ok(ResolvedWebTarget { url, resolved_ips })
}

#[derive(Clone)]
pub struct AgentWebTools {
    resolver: Arc<dyn AgentDnsResolver>,
    transport: Arc<dyn AgentWebHttpTransport>,
    search: Option<Arc<dyn AgentWebSearch>>,
    allow_private_fetch: bool,
}

impl AgentWebTools {
    pub fn new(
        resolver: Arc<dyn AgentDnsResolver>,
        transport: Arc<dyn AgentWebHttpTransport>,
        search: Option<Arc<dyn AgentWebSearch>>,
        allow_private_fetch: bool,
    ) -> Self {
        Self {
            resolver,
            transport,
            search,
            allow_private_fetch,
        }
    }

    pub fn has_search(&self) -> bool {
        self.search.is_some()
    }

    pub async fn search_is_configured(&self) -> Result<bool, AgentPortError> {
        match &self.search {
            Some(search) => search.is_configured().await,
            None => Ok(false),
        }
    }

    pub async fn search(&self, query: &str) -> String {
        let Some(search) = &self.search else {
            return "Web search is not configured.".to_owned();
        };
        match search.search(query, WEB_SEARCH_MAX_RESULTS).await {
            Ok(results) => {
                let serialized = serde_json::to_string(&results_to_json(&results))
                    .unwrap_or_else(|_| "[]".to_owned());
                truncate_utf8(&serialized, WEB_SEARCH_RESULT_MAX_BYTES)
            }
            Err(error) => format!(
                "Web search failed: {}",
                redact_secrets(error.message()).text
            ),
        }
    }

    pub async fn fetch_url(&self, raw_url: &str) -> String {
        let mut current_url = raw_url.to_owned();
        for _ in 0..=FETCH_URL_MAX_REDIRECTS {
            let target = match resolve_fetch_target(
                &current_url,
                self.allow_private_fetch,
                self.resolver.as_ref(),
            )
            .await
            {
                Ok(target) => target,
                Err(error) => return error.to_string(),
            };
            let base_url = target.url.clone();
            let response = match self
                .transport
                .send(WebHttpRequest {
                    method: WebHttpMethod::Get,
                    target,
                    timeout: FETCH_URL_TIMEOUT,
                    max_body_bytes: FETCH_URL_MAX_BODY_BYTES,
                    headers: BTreeMap::from([(
                        "Accept".to_owned(),
                        "text/html,application/xhtml+xml,text/plain,*/*".to_owned(),
                    )]),
                    body: Vec::new(),
                })
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    return format!("Fetch failed: {}", redact_secrets(error.message()).text);
                }
            };

            if (300..400).contains(&response.status) {
                let Some(location) = header(&response.headers, "location") else {
                    return format!(
                        "Fetch failed: HTTP {} redirect without Location header",
                        response.status
                    );
                };
                current_url = match base_url.join(location) {
                    Ok(url) => url.to_string(),
                    Err(_) => return "Fetch failed: invalid redirect URL".to_owned(),
                };
                continue;
            }
            if !(200..300).contains(&response.status) {
                return format!("Fetch failed: HTTP {}", response.status);
            }

            let body_len = response.body.len().min(FETCH_URL_MAX_BODY_BYTES);
            let body = String::from_utf8_lossy(&response.body[..body_len]);
            let content_type = header(&response.headers, "content-type").unwrap_or_default();
            let text = if content_type.contains("text/html")
                || content_type.contains("application/xhtml")
            {
                match extract_html_text(&body) {
                    Ok(text) => text,
                    Err(error) => return format!("Fetch failed: {}", error.message()),
                }
            } else {
                body.into_owned()
            };
            return wrap_untrusted(
                &truncate_utf8(&text, FETCH_URL_TEXT_MAX_BYTES),
                UntrustedContentKind::Web,
            );
        }
        format!("Fetch failed: too many redirects (>{FETCH_URL_MAX_REDIRECTS})")
    }
}

fn header<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn results_to_json(results: &[WebSearchResultItem]) -> Vec<serde_json::Value> {
    results
        .iter()
        .map(|item| {
            serde_json::json!({
                "title": item.title,
                "url": item.url,
                "snippet": item.snippet,
            })
        })
        .collect()
}

fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}

struct HtmlPatterns {
    strip_blocks: Vec<Regex>,
    strip_tags: Regex,
    collapse_space: Regex,
    collapse_lines: Regex,
}

static HTML_PATTERNS: LazyLock<Result<HtmlPatterns, regex::Error>> = LazyLock::new(|| {
    let strip_blocks = [
        "script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside",
        "iframe",
    ]
    .into_iter()
    .map(|tag| Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}\s*>")))
    .collect::<Result<Vec<_>, _>>()?;
    Ok(HtmlPatterns {
        strip_blocks,
        strip_tags: Regex::new(r"(?s)<[^>]*>")?,
        collapse_space: Regex::new(r"[ \t\u{a0}]+")?,
        collapse_lines: Regex::new(r"(?:[ \t]*\n[ \t]*){2,}")?,
    })
});

fn extract_html_text(html: &str) -> Result<String, AgentPortError> {
    let patterns = HTML_PATTERNS
        .as_ref()
        .map_err(|_| AgentPortError::new("HTML sanitizer initialization failed"))?;
    let mut value = html.to_owned();
    for pattern in &patterns.strip_blocks {
        value = pattern.replace_all(&value, " ").into_owned();
    }
    value = patterns.strip_tags.replace_all(&value, " ").into_owned();
    for (entity, replacement) in [
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
    ] {
        value = value.replace(entity, replacement);
    }
    value = patterns
        .collapse_space
        .replace_all(&value, " ")
        .into_owned();
    Ok(patterns
        .collapse_lines
        .replace_all(value.trim(), "\n\n")
        .into_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct FixedResolver {
        answers: Mutex<Vec<Vec<IpAddr>>>,
    }

    #[async_trait]
    impl AgentDnsResolver for FixedResolver {
        async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, AgentPortError> {
            Ok(self.answers.lock().expect("DNS answers").remove(0))
        }
    }

    #[test]
    fn blocks_literal_private_and_obfuscated_numeric_hosts() {
        for host in [
            "localhost",
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2130706433",
            "127.1",
            "0177.0.0.1",
            "0x7f000001",
        ] {
            assert!(is_private_hostname(host), "expected private: {host}");
        }
        assert!(!is_private_hostname("example.com"));
        assert!(!is_private_hostname("8.8.8.8"));
    }

    #[tokio::test]
    async fn rechecks_every_dns_answer_and_rejects_mixed_private_results() {
        let resolver = FixedResolver {
            answers: Mutex::new(vec![vec![
                "93.184.216.34".parse().expect("public IP"),
                "127.0.0.1".parse().expect("private IP"),
            ]]),
        };
        let error = resolve_fetch_target("https://example.com/path", false, &resolver)
            .await
            .expect_err("mixed DNS answer must be rejected");
        assert!(matches!(error, FetchUrlPolicyError::PrivateAddress(_)));
    }

    #[test]
    fn request_debug_omits_path_query_and_headers() {
        let request = WebHttpRequest {
            method: WebHttpMethod::Get,
            target: ResolvedWebTarget {
                url: Url::parse("https://example.com/private?token=sk-abcdefghijklmnop")
                    .expect("URL"),
                resolved_ips: vec!["93.184.216.34".parse().expect("IP")],
            },
            timeout: FETCH_URL_TIMEOUT,
            max_body_bytes: 10,
            headers: BTreeMap::from([(
                "Authorization".to_owned(),
                "Bearer sk-abcdefghijklmnop".to_owned(),
            )]),
            body: b"body-secret-marker".to_vec(),
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("private"));
        assert!(!debug.contains("token="));
        assert!(!debug.contains("Bearer"));
        assert!(!debug.contains("sk-"));
        assert!(!debug.contains("body-secret-marker"));
    }
}
