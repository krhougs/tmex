use std::collections::HashMap;
use std::fmt;
use std::future::pending;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use serde_json::Value;

use crate::agent::{redact_known_secret, redact_secrets, AgentRunControl};

const ERROR_BODY_LIMIT: usize = 4 * 1024;
const RETRY_AFTER_LIMIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivateNetworkPolicy {
    AllowPrivate,
    PublicOnly,
}

#[derive(Clone, Debug)]
pub struct OpenAiTransportPolicy {
    pub private_network: PrivateNetworkPolicy,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub max_sse_event_bytes: usize,
}

impl Default for OpenAiTransportPolicy {
    fn default() -> Self {
        Self {
            // Provider base URLs are administrator-owned configuration. Local and
            // private OpenAI-compatible servers are part of the supported surface.
            private_network: PrivateNetworkPolicy::AllowPrivate,
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(10 * 60),
            max_request_bytes: 16 * 1024 * 1024,
            max_response_bytes: 64 * 1024 * 1024,
            max_sse_event_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug)]
struct ResolvedEndpointClient {
    addresses: Vec<SocketAddr>,
    client: reqwest::Client,
}

type ResolvedClientMap = HashMap<(String, u16), Arc<ResolvedEndpointClient>>;

#[derive(Clone, Debug, Default)]
pub struct OpenAiHttpTransport {
    policy: OpenAiTransportPolicy,
    clients: Arc<Mutex<ResolvedClientMap>>,
}

impl OpenAiHttpTransport {
    pub fn new(policy: OpenAiTransportPolicy) -> Self {
        Self {
            policy,
            clients: Arc::default(),
        }
    }

    pub fn policy(&self) -> &OpenAiTransportPolicy {
        &self.policy
    }

    pub(crate) async fn post_json_with_retries(
        &self,
        endpoint_url: &str,
        api_key: &str,
        body: &Value,
        max_retries: u32,
        control: Option<&AgentRunControl>,
    ) -> Result<reqwest::Response, OpenAiTransportError> {
        let serialized = serde_json::to_vec(body)
            .map_err(|_| OpenAiTransportError::fatal("failed to encode language-model request"))?;
        if serialized.len() > self.policy.max_request_bytes {
            return Err(OpenAiTransportError::fatal(
                "language-model request exceeds the configured size limit",
            ));
        }

        let mut attempt = 0;
        loop {
            if is_cancelled(control) {
                return Err(OpenAiTransportError::cancelled());
            }
            match self
                .post_json_once(endpoint_url, api_key, serialized.clone(), control)
                .await
            {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    let retry_after = parse_retry_after(response.headers().get(RETRY_AFTER));
                    let retryable =
                        matches!(status.as_u16(), 408 | 409 | 429) || status.is_server_error();
                    let body = read_response_bytes(
                        response,
                        ERROR_BODY_LIMIT,
                        control,
                        "language-model error response",
                    )
                    .await
                    .unwrap_or_default();
                    let detail = sanitize_provider_detail(&body, api_key);
                    if retryable && attempt < max_retries {
                        let delay = retry_after.unwrap_or_else(|| retry_delay(attempt));
                        wait_or_cancel(delay, control).await?;
                        attempt += 1;
                        continue;
                    }
                    let message = if detail.is_empty() {
                        format!("language-model provider returned HTTP {}", status.as_u16())
                    } else {
                        format!(
                            "language-model provider returned HTTP {}: {detail}",
                            status.as_u16()
                        )
                    };
                    return Err(OpenAiTransportError::new(message, retryable, false));
                }
                Err(error) if error.retryable && attempt < max_retries => {
                    wait_or_cancel(retry_delay(attempt), control).await?;
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(crate) async fn get_bytes(
        &self,
        endpoint_url: &str,
        authorization: &str,
        timeout: Duration,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), OpenAiTransportError> {
        let (url, client) = self.resolve_client(endpoint_url, None).await?;
        let mut authorization = HeaderValue::from_str(authorization)
            .map_err(|_| OpenAiTransportError::fatal("invalid language-model authorization"))?;
        authorization.set_sensitive(true);
        let request = client
            .get(url)
            .header(AUTHORIZATION, authorization)
            .timeout(timeout)
            .send();
        tokio::pin!(request);
        let response = request.await.map_err(|error| {
            if error.is_timeout() {
                OpenAiTransportError::new("language-model request timed out", true, false)
            } else {
                OpenAiTransportError::retryable(
                    "language-model request failed before a response was received",
                )
            }
        })?;
        let status = response.status();
        let body = read_response_bytes(
            response,
            self.policy.max_response_bytes,
            None,
            "language-model response",
        )
        .await?;
        Ok((status, body))
    }

    async fn post_json_once(
        &self,
        endpoint_url: &str,
        api_key: &str,
        body: Vec<u8>,
        control: Option<&AgentRunControl>,
    ) -> Result<reqwest::Response, OpenAiTransportError> {
        let (url, client) = self.resolve_client(endpoint_url, control).await?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| OpenAiTransportError::fatal("invalid language-model API key"))?;
        authorization.set_sensitive(true);
        let request = client
            .post(url)
            .header(AUTHORIZATION, authorization)
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send();
        tokio::pin!(request);
        tokio::select! {
            result = &mut request => result.map_err(|error| {
                if error.is_timeout() || error.is_connect() || error.is_request() {
                    OpenAiTransportError::retryable("language-model request failed before a response was received")
                } else {
                    OpenAiTransportError::fatal("language-model request failed")
                }
            }),
            _ = wait_for_control(control) => Err(OpenAiTransportError::cancelled()),
        }
    }

    async fn resolve_client(
        &self,
        endpoint_url: &str,
        control: Option<&AgentRunControl>,
    ) -> Result<(reqwest::Url, reqwest::Client), OpenAiTransportError> {
        let url = reqwest::Url::parse(endpoint_url)
            .map_err(|_| OpenAiTransportError::fatal("invalid language-model endpoint URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(OpenAiTransportError::fatal(
                "language-model endpoint must be an HTTP(S) URL without credentials or a fragment",
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| OpenAiTransportError::fatal("language-model endpoint has no host"))?;
        let resolution_host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        let port = url
            .port_or_known_default()
            .ok_or_else(|| OpenAiTransportError::fatal("language-model endpoint has no port"))?;

        let addresses = if let Ok(address) = resolution_host.parse::<IpAddr>() {
            vec![SocketAddr::new(address, port)]
        } else {
            let lookup = tokio::time::timeout(
                self.policy.connect_timeout,
                tokio::net::lookup_host((resolution_host, port)),
            );
            tokio::pin!(lookup);
            let resolved = tokio::select! {
                result = &mut lookup => match result {
                    Ok(Ok(resolved)) => resolved,
                    Ok(Err(_)) => return Err(OpenAiTransportError::retryable(
                        "failed to resolve language-model endpoint",
                    )),
                    Err(_) => return Err(OpenAiTransportError::retryable(
                        "language-model endpoint resolution timed out",
                    )),
                },
                _ = wait_for_control(control) => return Err(OpenAiTransportError::cancelled()),
            };
            let mut addresses = resolved.collect::<Vec<_>>();
            addresses.sort_unstable();
            addresses.dedup();
            addresses
        };
        if addresses.is_empty() {
            return Err(OpenAiTransportError::retryable(
                "language-model endpoint resolved to no addresses",
            ));
        }
        if self.policy.private_network == PrivateNetworkPolicy::PublicOnly
            && addresses.iter().any(|address| !is_public_ip(address.ip()))
        {
            return Err(OpenAiTransportError::fatal(
                "language-model endpoint resolved to a private or non-routable address",
            ));
        }

        let key = (resolution_host.to_owned(), port);
        let cached = {
            let clients = self
                .clients
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clients
                .get(&key)
                .filter(|entry| entry.addresses == addresses)
                .map(|entry| entry.client.clone())
        };
        let client = match cached {
            Some(client) => client,
            None => {
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .referer(false)
                    .no_proxy()
                    .connect_timeout(self.policy.connect_timeout)
                    .resolve_to_addrs(resolution_host, &addresses)
                    .build()
                    .map_err(|_| {
                        OpenAiTransportError::fatal("failed to initialize HTTP transport")
                    })?;
                let mut clients = self
                    .clients
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                clients.insert(
                    key,
                    Arc::new(ResolvedEndpointClient {
                        addresses,
                        client: client.clone(),
                    }),
                );
                client
            }
        };
        Ok((url, client))
    }
    pub(crate) async fn read_json(
        &self,
        response: reqwest::Response,
        control: Option<&AgentRunControl>,
    ) -> Result<Value, OpenAiTransportError> {
        let bytes = read_response_bytes(
            response,
            self.policy.max_response_bytes,
            control,
            "language-model response",
        )
        .await?;
        serde_json::from_slice(&bytes).map_err(|_| {
            OpenAiTransportError::fatal("language-model provider returned invalid JSON")
        })
    }

    pub(crate) fn sse_reader(&self, response: reqwest::Response) -> SseReader {
        SseReader {
            response,
            buffer: Vec::new(),
            event_data: Vec::new(),
            total_bytes: 0,
            max_event_bytes: self.policy.max_sse_event_bytes,
            max_total_bytes: self.policy.max_response_bytes,
            eof: false,
        }
    }
}

#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OpenAiTransportError {
    message: String,
    retryable: bool,
    cancelled: bool,
}

impl OpenAiTransportError {
    fn new(message: impl AsRef<str>, retryable: bool, cancelled: bool) -> Self {
        Self {
            message: redact_secrets(message.as_ref()).text,
            retryable,
            cancelled,
        }
    }

    fn fatal(message: impl AsRef<str>) -> Self {
        Self::new(message, false, false)
    }

    fn retryable(message: impl AsRef<str>) -> Self {
        Self::new(message, true, false)
    }

    fn cancelled() -> Self {
        Self::new("language-model request was cancelled", false, true)
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for OpenAiTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiTransportError")
            .field("message", &self.message)
            .field("retryable", &self.retryable)
            .field("cancelled", &self.cancelled)
            .finish()
    }
}

pub(crate) struct SseReader {
    response: reqwest::Response,
    buffer: Vec<u8>,
    event_data: Vec<u8>,
    total_bytes: usize,
    max_event_bytes: usize,
    max_total_bytes: usize,
    eof: bool,
}

impl SseReader {
    pub(crate) async fn next_json(
        &mut self,
        control: Option<&AgentRunControl>,
    ) -> Result<Option<Value>, OpenAiTransportError> {
        loop {
            let Some(data) = self.next_data(control).await? else {
                return Ok(None);
            };
            if data.trim() == "[DONE]" {
                return Ok(None);
            }
            if data.trim().is_empty() {
                continue;
            }
            return serde_json::from_str(&data).map(Some).map_err(|_| {
                OpenAiTransportError::fatal("language-model provider returned an invalid SSE event")
            });
        }
    }

    async fn next_data(
        &mut self,
        control: Option<&AgentRunControl>,
    ) -> Result<Option<String>, OpenAiTransportError> {
        loop {
            while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.is_empty() {
                    if self.event_data.is_empty() {
                        continue;
                    }
                    if self.event_data.last() == Some(&b'\n') {
                        self.event_data.pop();
                    }
                    let data =
                        String::from_utf8(std::mem::take(&mut self.event_data)).map_err(|_| {
                            OpenAiTransportError::fatal("language-model SSE event is not UTF-8")
                        })?;
                    return Ok(Some(data));
                }
                if let Some(data) = line.strip_prefix(b"data:") {
                    let data = data.strip_prefix(b" ").unwrap_or(data);
                    if self.event_data.len() + data.len() + 1 > self.max_event_bytes {
                        return Err(OpenAiTransportError::fatal(
                            "language-model SSE event exceeds the configured size limit",
                        ));
                    }
                    self.event_data.extend_from_slice(data);
                    self.event_data.push(b'\n');
                }
            }

            if self.eof {
                if !self.buffer.is_empty() {
                    self.buffer.push(b'\n');
                    continue;
                }
                if !self.event_data.is_empty() {
                    if self.event_data.last() == Some(&b'\n') {
                        self.event_data.pop();
                    }
                    let data =
                        String::from_utf8(std::mem::take(&mut self.event_data)).map_err(|_| {
                            OpenAiTransportError::fatal("language-model SSE event is not UTF-8")
                        })?;
                    return Ok(Some(data));
                }
                return Ok(None);
            }

            let chunk = self.response.chunk();
            tokio::pin!(chunk);
            let chunk = tokio::select! {
                result = &mut chunk => result.map_err(|_| {
                    OpenAiTransportError::fatal("language-model SSE stream ended unexpectedly")
                })?,
                _ = wait_for_control(control) => return Err(OpenAiTransportError::cancelled()),
            };
            match chunk {
                Some(chunk) => {
                    self.total_bytes = self.total_bytes.saturating_add(chunk.len());
                    if self.total_bytes > self.max_total_bytes {
                        return Err(OpenAiTransportError::fatal(
                            "language-model stream exceeds the configured size limit",
                        ));
                    }
                    if self.buffer.len() + chunk.len() > self.max_event_bytes {
                        return Err(OpenAiTransportError::fatal(
                            "language-model SSE line exceeds the configured size limit",
                        ));
                    }
                    self.buffer.extend_from_slice(&chunk);
                }
                None => self.eof = true,
            }
        }
    }
}

async fn read_response_bytes(
    mut response: reqwest::Response,
    max_bytes: usize,
    control: Option<&AgentRunControl>,
    label: &str,
) -> Result<Vec<u8>, OpenAiTransportError> {
    let mut body = Vec::new();
    loop {
        let chunk = response.chunk();
        tokio::pin!(chunk);
        let chunk = tokio::select! {
            result = &mut chunk => result.map_err(|_| {
                OpenAiTransportError::fatal(format!("failed to read {label}"))
            })?,
            _ = wait_for_control(control) => return Err(OpenAiTransportError::cancelled()),
        };
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len() + chunk.len() > max_bytes {
            return Err(OpenAiTransportError::fatal(format!(
                "{label} exceeds the configured size limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }
}

async fn wait_for_control(control: Option<&AgentRunControl>) {
    match control {
        Some(control) => {
            control.changed().await;
        }
        None => pending::<()>().await,
    }
}

fn is_cancelled(control: Option<&AgentRunControl>) -> bool {
    control.is_some_and(|control| {
        !matches!(
            control.directive(),
            crate::agent::AgentRunDirective::Continue
        )
    })
}

async fn wait_or_cancel(
    delay: Duration,
    control: Option<&AgentRunControl>,
) -> Result<(), OpenAiTransportError> {
    tokio::select! {
        _ = tokio::time::sleep(delay) => Ok(()),
        _ = wait_for_control(control) => Err(OpenAiTransportError::cancelled()),
    }
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(250_u64.saturating_mul(1_u64 << attempt.min(4)))
}

fn parse_retry_after(value: Option<&HeaderValue>) -> Option<Duration> {
    let value = value.and_then(|value| value.to_str().ok())?;
    let duration = match value.parse::<u64>() {
        Ok(seconds) => Duration::from_secs(seconds),
        Err(_) => {
            let deadline = chrono::DateTime::parse_from_rfc2822(value).ok()?;
            let remaining = deadline.signed_duration_since(chrono::Utc::now());
            remaining.to_std().unwrap_or(Duration::ZERO)
        }
    };
    Some(duration.min(RETRY_AFTER_LIMIT))
}

fn sanitize_provider_detail(body: &[u8], api_key: &str) -> String {
    let value = String::from_utf8_lossy(body);
    let redacted = redact_known_secret(&value, Some(api_key));
    redact_secrets(redacted.trim()).text
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && matches!(b, 18 | 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] & 0xff00) == 0xff00)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_policy_allows_private_provider_endpoints() {
        assert_eq!(
            OpenAiTransportPolicy::default().private_network,
            PrivateNetworkPolicy::AllowPrivate
        );
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_public_ip("fd00::1".parse().unwrap()));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn transport_errors_do_not_echo_known_secrets() {
        let detail = sanitize_provider_detail(
            b"request rejected: sk-abcdefghijklmnop",
            "sk-abcdefghijklmnop",
        );
        assert!(!detail.contains("sk-abcdefghijklmnop"));
        let error = OpenAiTransportError::new(detail, false, false);
        assert!(!format!("{error:?}").contains("sk-abcdefghijklmnop"));
    }
}
