use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use icu_collator::{options::CollatorOptions, Collator, CollatorPreferences};
use icu_locale::locale;

use crate::crypto::{CryptoContext, CryptoDecryptError, CryptoError, MasterKey};
use crate::database::repository::{Repository, RepositoryError};
use crate::entity::llm_providers;

pub const FETCH_MODELS_TIMEOUT: Duration = Duration::from_secs(15);
pub const DIAGNOSTIC_EXCERPT_BYTES: usize = 500;

const OPENAI_RESPONSES_PROTOCOL: &str = "openai-responses";

pub fn resolve_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim();
    let without_fragment = trimmed.split_once('#').map_or(trimmed, |(base, _)| base);

    if without_fragment.ends_with('/') {
        return without_fragment.trim_end_matches('/').to_owned();
    }

    if has_version_suffix(without_fragment) {
        return without_fragment.to_owned();
    }

    format!("{without_fragment}/v1")
}

fn has_version_suffix(value: &str) -> bool {
    let Some((_, segment)) = value.rsplit_once('/') else {
        return false;
    };
    segment.strip_prefix('v').is_some_and(|version| {
        !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
    })
}

#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanguageModelEndpointKind {
    ChatCompletions,
    Responses,
}

impl LanguageModelEndpointKind {
    fn from_stored_protocol(protocol: &str) -> Self {
        if protocol == OPENAI_RESPONSES_PROTOCOL {
            Self::Responses
        } else {
            Self::ChatCompletions
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::ChatCompletions => "/chat/completions",
            Self::Responses => "/responses",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanguageModelEndpoint {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub kind: LanguageModelEndpointKind,
    pub base_url: String,
    pub endpoint_url: String,
    pub api_key: SecretString,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenAiResponsesEndpoint {
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub endpoint_url: String,
    pub api_key: SecretString,
}

#[derive(Clone)]
pub struct ProviderRegistry {
    repository: Repository,
    master_key: MasterKey,
}

impl ProviderRegistry {
    pub fn new(repository: Repository, master_key: MasterKey) -> Self {
        Self {
            repository,
            master_key,
        }
    }

    pub async fn resolve_language_model(
        &self,
        provider_id: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<LanguageModelEndpoint, ProviderRegistryError> {
        let needs_defaults = is_js_falsey_string(provider_id) || is_js_falsey_string(model_id);
        let settings = if needs_defaults {
            Some(self.repository.get_agent_settings().await?)
        } else {
            None
        };
        let (provider_id, model_id) = resolve_language_model_ids(
            provider_id,
            model_id,
            settings
                .as_ref()
                .and_then(|settings| settings.default_provider_id.as_deref()),
            settings
                .as_ref()
                .and_then(|settings| settings.default_model_id.as_deref()),
        )?;

        let provider = self
            .repository
            .get_llm_provider_by_id(&provider_id)
            .await?
            .ok_or(ProviderRegistryError::ProviderNotFound)?;
        resolve_language_model_endpoint(&self.master_key, &provider, model_id)
    }

    pub async fn resolve_openai_responses_provider(
        &self,
        provider_id: Option<&str>,
    ) -> Result<Option<OpenAiResponsesEndpoint>, ProviderRegistryError> {
        let effective_provider_id = match provider_id {
            Some(provider_id) => Some(provider_id.to_owned()),
            None => {
                self.repository
                    .get_agent_settings()
                    .await?
                    .default_provider_id
            }
        };
        let Some(provider_id) = effective_provider_id else {
            return Ok(None);
        };
        let Some(provider) = self.repository.get_llm_provider_by_id(&provider_id).await? else {
            return Ok(None);
        };
        if provider.enabled == 0 || provider.protocol != OPENAI_RESPONSES_PROTOCOL {
            return Ok(None);
        }

        let api_key = decrypt_provider_api_key(&self.master_key, &provider)?;
        let base_url = resolve_base_url(&provider.base_url);
        Ok(Some(OpenAiResponsesEndpoint {
            provider_id: provider.id,
            provider_name: provider.name,
            endpoint_url: format!("{base_url}/responses"),
            base_url,
            api_key,
        }))
    }

    pub async fn fetch_provider_models<T: ModelsHttpTransport + ?Sized>(
        &self,
        provider: &llm_providers::Model,
        transport: &T,
        options: FetchModelsOptions,
    ) -> Result<Vec<String>, FetchModelsError> {
        fetch_provider_models(
            &self.master_key,
            EncryptedProviderAccess::from(provider),
            transport,
            options,
        )
        .await
    }
}

fn is_js_falsey_string(value: Option<&str>) -> bool {
    value.is_none_or(str::is_empty)
}

fn js_string_or(value: Option<&str>, fallback: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty())
        .or_else(|| fallback.filter(|value| !value.is_empty()))
        .map(str::to_owned)
}

fn resolve_language_model_ids(
    provider_id: Option<&str>,
    model_id: Option<&str>,
    default_provider_id: Option<&str>,
    default_model_id: Option<&str>,
) -> Result<(String, String), ProviderRegistryError> {
    let provider_id = js_string_or(provider_id, default_provider_id)
        .ok_or(ProviderRegistryError::NoDefaultProvider)?;
    let model_id =
        js_string_or(model_id, default_model_id).ok_or(ProviderRegistryError::NoDefaultModel)?;
    Ok((provider_id, model_id))
}

fn resolve_language_model_endpoint(
    master_key: &MasterKey,
    provider: &llm_providers::Model,
    model_id: String,
) -> Result<LanguageModelEndpoint, ProviderRegistryError> {
    if provider.enabled == 0 {
        return Err(ProviderRegistryError::ProviderDisabled {
            name: provider.name.clone(),
        });
    }
    let kind = LanguageModelEndpointKind::from_stored_protocol(&provider.protocol);
    let api_key = decrypt_provider_api_key(master_key, provider)?;
    let base_url = resolve_base_url(&provider.base_url);
    Ok(LanguageModelEndpoint {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id,
        kind,
        endpoint_url: format!("{base_url}{}", kind.suffix()),
        base_url,
        api_key,
    })
}

fn decrypt_provider_api_key(
    master_key: &MasterKey,
    provider: &llm_providers::Model,
) -> Result<SecretString, ProviderRegistryError> {
    master_key
        .decrypt_with_context(
            &provider.api_key_enc,
            CryptoContext::new("llm_provider")
                .entity_id(&provider.id)
                .field("api_key_enc"),
        )
        .map(SecretString::new)
        .map_err(ProviderRegistryError::Decrypt)
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderRegistryError {
    #[error("no LLM provider specified and no default provider configured")]
    NoDefaultProvider,
    #[error("no model specified and no default model configured")]
    NoDefaultModel,
    #[error("LLM provider not found")]
    ProviderNotFound,
    #[error("LLM provider {name} is disabled")]
    ProviderDisabled { name: String },
    #[error(transparent)]
    Repository(#[from] RepositoryError),
    #[error(transparent)]
    Decrypt(#[from] CryptoDecryptError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncryptedProviderAccess<'a> {
    pub base_url: &'a str,
    pub api_key_enc: &'a str,
}

impl<'a> From<&'a llm_providers::Model> for EncryptedProviderAccess<'a> {
    fn from(provider: &'a llm_providers::Model) -> Self {
        Self {
            base_url: &provider.base_url,
            api_key_enc: &provider.api_key_enc,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FetchModelsOptions {
    pub timeout: Option<Duration>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ModelsHttpRequest {
    pub url: String,
    pub timeout: Duration,
    authorization: SecretString,
}

impl ModelsHttpRequest {
    pub fn authorization(&self) -> &str {
        self.authorization.expose_secret()
    }
}

impl fmt::Debug for ModelsHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelsHttpRequest")
            .field("url", &self.url)
            .field("timeout", &self.timeout)
            .field("authorization", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelsHttpResponse {
    pub status: u16,
    pub status_text: String,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ModelsHttpTransportError {
    timeout: bool,
    message: String,
}

impl ModelsHttpTransportError {
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            timeout: true,
            message: message.into(),
        }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self {
            timeout: false,
            message: message.into(),
        }
    }

    pub fn is_timeout(&self) -> bool {
        self.timeout
    }
}

pub type ModelsHttpFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ModelsHttpResponse, ModelsHttpTransportError>> + Send + 'a>>;

pub trait ModelsHttpTransport: Send + Sync {
    fn get(&self, request: ModelsHttpRequest) -> ModelsHttpFuture<'_>;
}

#[derive(Clone, Debug, Default)]
pub struct ReqwestModelsHttpTransport {
    client: Option<reqwest::Client>,
    secure_transport: super::OpenAiHttpTransport,
}

impl ReqwestModelsHttpTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client: Some(client),
            secure_transport: super::OpenAiHttpTransport::default(),
        }
    }
}

impl ModelsHttpTransport for ReqwestModelsHttpTransport {
    fn get(&self, request: ModelsHttpRequest) -> ModelsHttpFuture<'_> {
        Box::pin(async move {
            let (status, body) = match &self.client {
                Some(client) => {
                    let response = client
                        .get(&request.url)
                        .header(reqwest::header::AUTHORIZATION, request.authorization())
                        .timeout(request.timeout)
                        .send()
                        .await
                        .map_err(reqwest_transport_error)?;
                    let status = response.status();
                    let mut body = Vec::new();
                    let mut response = response;
                    while let Some(chunk) =
                        response.chunk().await.map_err(reqwest_transport_error)?
                    {
                        if body.len() + chunk.len()
                            > self.secure_transport.policy().max_response_bytes
                        {
                            return Err(ModelsHttpTransportError::other(
                                "model-list response exceeds the configured size limit",
                            ));
                        }
                        body.extend_from_slice(&chunk);
                    }
                    (status, body)
                }
                None => self
                    .secure_transport
                    .get_bytes(&request.url, request.authorization(), request.timeout)
                    .await
                    .map_err(|error| {
                        if error.message().contains("timed out") {
                            ModelsHttpTransportError::timeout(error.message())
                        } else {
                            ModelsHttpTransportError::other(error.message())
                        }
                    })?,
            };
            let status_text = status.canonical_reason().unwrap_or_default().to_owned();
            Ok(ModelsHttpResponse {
                status: status.as_u16(),
                status_text,
                body,
            })
        })
    }
}

fn reqwest_transport_error(error: reqwest::Error) -> ModelsHttpTransportError {
    if error.is_timeout() {
        ModelsHttpTransportError::timeout(error.to_string())
    } else {
        ModelsHttpTransportError::other(error.to_string())
    }
}

pub async fn fetch_provider_models<T: ModelsHttpTransport + ?Sized>(
    master_key: &MasterKey,
    provider: EncryptedProviderAccess<'_>,
    transport: &T,
    options: FetchModelsOptions,
) -> Result<Vec<String>, FetchModelsError> {
    let api_key = master_key.decrypt(provider.api_key_enc)?;
    let base_url = resolve_base_url(provider.base_url);
    let models_url = format!("{base_url}/models");
    let request = ModelsHttpRequest {
        url: models_url.clone(),
        timeout: options.timeout.unwrap_or(FETCH_MODELS_TIMEOUT),
        authorization: SecretString::new(format!("Bearer {api_key}")),
    };

    let response = transport.get(request).await.map_err(|source| {
        if source.is_timeout() {
            FetchModelsError::Timeout { source }
        } else {
            let detail = source.to_string();
            FetchModelsError::Transport { detail, source }
        }
    })?;

    if !(200..300).contains(&response.status) {
        return Err(FetchModelsError::HttpStatus {
            url: models_url,
            status: response.status,
            status_text: response.status_text,
            body_excerpt: diagnostic_body_excerpt(&response.body, Some(&api_key)),
        });
    }

    let payload: serde_json::Value =
        serde_json::from_slice(&response.body).map_err(FetchModelsError::InvalidJson)?;
    let Some(data) = payload.get("data").and_then(serde_json::Value::as_array) else {
        let serialized = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_owned());
        return Err(FetchModelsError::UnexpectedShape {
            url: models_url,
            payload_excerpt: sanitize_diagnostic(&serialized, Some(&api_key)),
        });
    };

    let mut ids = data
        .iter()
        .filter_map(|item| item.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Ok(collator) = Collator::try_new(
        CollatorPreferences::from(locale!("en-US")),
        CollatorOptions::default(),
    ) {
        ids.sort_by(|left, right| collator.compare(left, right));
    } else {
        ids.sort();
    }
    Ok(ids)
}

fn diagnostic_body_excerpt(body: &[u8], secret: Option<&str>) -> String {
    sanitize_diagnostic(&String::from_utf8_lossy(body), secret)
}

fn sanitize_diagnostic(value: &str, secret: Option<&str>) -> String {
    let redacted = crate::agent::redact_known_secret(value, secret);
    let redacted = crate::agent::redact_secrets(&redacted).text;
    truncate_utf16_units(&redacted, DIAGNOSTIC_EXCERPT_BYTES)
}

fn truncate_utf16_units(value: &str, max_units: usize) -> String {
    let units = value.encode_utf16().take(max_units).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchModelsErrorKind {
    Decrypt,
    Timeout,
    Transport,
    HttpStatus,
    InvalidJson,
    UnexpectedShape,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchModelsError {
    #[error(transparent)]
    Decrypt(#[from] CryptoError),
    #[error("failed to fetch model list: timeout")]
    Timeout {
        #[source]
        source: ModelsHttpTransportError,
    },
    #[error("failed to fetch model list: {detail}")]
    Transport {
        detail: String,
        #[source]
        source: ModelsHttpTransportError,
    },
    #[error("failed to fetch model list: HTTP {status}")]
    HttpStatus {
        url: String,
        status: u16,
        status_text: String,
        body_excerpt: String,
    },
    #[error("failed to fetch model list: invalid JSON response")]
    InvalidJson(#[source] serde_json::Error),
    #[error("failed to fetch model list: unexpected response shape")]
    UnexpectedShape {
        url: String,
        payload_excerpt: String,
    },
}

impl FetchModelsError {
    pub fn kind(&self) -> FetchModelsErrorKind {
        match self {
            Self::Decrypt(_) => FetchModelsErrorKind::Decrypt,
            Self::Timeout { .. } => FetchModelsErrorKind::Timeout,
            Self::Transport { .. } => FetchModelsErrorKind::Transport,
            Self::HttpStatus { .. } => FetchModelsErrorKind::HttpStatus,
            Self::InvalidJson(_) => FetchModelsErrorKind::InvalidJson,
            Self::UnexpectedShape { .. } => FetchModelsErrorKind::UnexpectedShape,
        }
    }

    pub fn diagnostic(&self) -> String {
        let diagnostic = match self {
            Self::Decrypt(source) => source.to_string(),
            Self::Timeout { source } | Self::Transport { source, .. } => source.to_string(),
            Self::HttpStatus {
                url,
                status,
                status_text,
                body_excerpt,
            } => {
                let body = if body_excerpt.is_empty() {
                    String::new()
                } else {
                    format!("\n{body_excerpt}")
                };
                format!("GET {url} -> HTTP {status} {status_text}{body}")
            }
            Self::InvalidJson(source) => source.to_string(),
            Self::UnexpectedShape {
                url,
                payload_excerpt,
            } => format!("GET {url} 返回非 {{data:[]}} 结构: {payload_excerpt}"),
        };
        crate::agent::redact_secrets(&diagnostic).text
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;

    const TYPESCRIPT_CIPHERTEXT: &str = "AAECAwQFBgcICQoL/KZWKi0YCkUn1uv65d4zIL8kmca2F/84jnWa";

    fn provider(protocol: &str, enabled: bool) -> llm_providers::Model {
        llm_providers::Model {
            id: "provider-1".to_owned(),
            name: "Example".to_owned(),
            protocol: protocol.to_owned(),
            base_url: " https://api.example.com/openai#ignored ".to_owned(),
            api_key_enc: TYPESCRIPT_CIPHERTEXT.to_owned(),
            enabled: i64::from(enabled),
            models_cache: None,
            models_fetched_at: None,
            manual_models: "[]".to_owned(),
            disabled_models: "[]".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn base_url_and_default_selection_match_javascript_truthiness() {
        assert_eq!(
            resolve_base_url(" https://api.example.com "),
            "https://api.example.com/v1"
        );
        assert_eq!(
            resolve_base_url("https://api.example.com/v2"),
            "https://api.example.com/v2"
        );
        assert_eq!(
            resolve_base_url(" https://api.example.com/v1// "),
            "https://api.example.com/v1"
        );
        assert_eq!(
            resolve_base_url("https://api.example.com#fragment"),
            "https://api.example.com/v1"
        );
        assert_eq!(resolve_base_url("v1"), "v1/v1");
        assert_eq!(
            resolve_language_model_ids(Some(""), None, Some("default-p"), Some("default-m"))
                .expect("fallback defaults"),
            ("default-p".to_owned(), "default-m".to_owned())
        );
        assert_eq!(
            resolve_language_model_ids(Some(" "), Some("model"), None, None)
                .expect("whitespace remains truthy")
                .0,
            " "
        );
    }

    #[test]
    fn descriptors_decrypt_legacy_ciphertext_and_select_the_exact_endpoint() {
        let key = MasterKey::development_default();
        let chat = resolve_language_model_endpoint(
            &key,
            &provider("openai-chat", true),
            "model-a".to_owned(),
        )
        .expect("chat descriptor");
        assert_eq!(chat.kind, LanguageModelEndpointKind::ChatCompletions);
        assert_eq!(
            chat.endpoint_url,
            "https://api.example.com/openai/v1/chat/completions"
        );
        assert_eq!(chat.api_key.expose_secret(), "tmex-兼容");
        assert!(!format!("{chat:?}").contains("tmex-兼容"));

        let responses = resolve_language_model_endpoint(
            &key,
            &provider(OPENAI_RESPONSES_PROTOCOL, true),
            "model-b".to_owned(),
        )
        .expect("responses descriptor");
        assert_eq!(responses.kind, LanguageModelEndpointKind::Responses);
        assert_eq!(
            responses.endpoint_url,
            "https://api.example.com/openai/v1/responses"
        );

        let unknown = resolve_language_model_endpoint(
            &key,
            &provider("future-protocol", true),
            "model-c".to_owned(),
        )
        .expect("legacy fallback");
        assert_eq!(unknown.kind, LanguageModelEndpointKind::ChatCompletions);
        assert!(matches!(
            resolve_language_model_endpoint(
                &key,
                &provider("openai-chat", false),
                "model-d".to_owned()
            ),
            Err(ProviderRegistryError::ProviderDisabled { .. })
        ));
    }

    #[derive(Clone, Default)]
    struct FakeTransport {
        requests: Arc<Mutex<Vec<ModelsHttpRequest>>>,
        responses: Arc<Mutex<VecDeque<Result<ModelsHttpResponse, ModelsHttpTransportError>>>>,
    }

    impl FakeTransport {
        fn with_responses(
            responses: impl IntoIterator<Item = Result<ModelsHttpResponse, ModelsHttpTransportError>>,
        ) -> Self {
            Self {
                requests: Arc::default(),
                responses: Arc::new(Mutex::new(responses.into_iter().collect())),
            }
        }
    }

    impl ModelsHttpTransport for FakeTransport {
        fn get(&self, request: ModelsHttpRequest) -> ModelsHttpFuture<'_> {
            self.requests.lock().expect("request lock").push(request);
            let response = self
                .responses
                .lock()
                .expect("response lock")
                .pop_front()
                .expect("fake response");
            Box::pin(async move { response })
        }
    }

    fn response(status: u16, body: impl Into<Vec<u8>>) -> ModelsHttpResponse {
        ModelsHttpResponse {
            status,
            status_text: if status == 200 {
                "OK".to_owned()
            } else {
                "Unauthorized".to_owned()
            },
            body: body.into(),
        }
    }

    #[tokio::test]
    async fn model_fetch_uses_bearer_default_timeout_and_sorts_string_ids() {
        let transport = FakeTransport::with_responses([Ok(response(
            200,
            br#"{"data":[{"id":"zeta"},{"id":7},{"id":"z"},{"id":"Z"},{"id":"\u00e1"},{"id":"\u00e4"},{"id":"a"},{"id":"10"},{"id":"2"},{"other":true},{"id":"alpha"},{"id":"mid"},{"id":"\u6a21\u578b\u4e59"},{"id":"\u6a21\u578b\u7532"}]}"#,
        ))]);
        let models = fetch_provider_models(
            &MasterKey::development_default(),
            EncryptedProviderAccess {
                base_url: "https://api.example.com/v1/",
                api_key_enc: TYPESCRIPT_CIPHERTEXT,
            },
            &transport,
            FetchModelsOptions::default(),
        )
        .await
        .expect("fetch models");
        assert_eq!(
            models,
            [
                "10",
                "2",
                "a",
                "á",
                "ä",
                "alpha",
                "mid",
                "z",
                "Z",
                "zeta",
                "模型乙",
                "模型甲"
            ]
        );

        let requests = transport.requests.lock().expect("request lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url, "https://api.example.com/v1/models");
        assert_eq!(requests[0].authorization(), "Bearer tmex-兼容");
        assert_eq!(requests[0].timeout, FETCH_MODELS_TIMEOUT);
        assert!(!format!("{:?}", requests[0]).contains("tmex-兼容"));
    }

    #[tokio::test]
    async fn model_fetch_classifies_failures_and_caps_diagnostic_excerpts() {
        let oversized_body = "x".repeat(DIAGNOSTIC_EXCERPT_BYTES + 50);
        let transport = FakeTransport::with_responses([
            Err(ModelsHttpTransportError::timeout("deadline elapsed")),
            Ok(response(401, oversized_body)),
            Ok(response(200, b"not-json".to_vec())),
            Ok(response(200, br#"{"models":["x"]}"#.to_vec())),
        ]);
        let key = MasterKey::development_default();
        let access = EncryptedProviderAccess {
            base_url: "https://api.example.com",
            api_key_enc: TYPESCRIPT_CIPHERTEXT,
        };

        let timeout =
            fetch_provider_models(&key, access, &transport, FetchModelsOptions::default())
                .await
                .expect_err("timeout");
        assert_eq!(timeout.kind(), FetchModelsErrorKind::Timeout);
        assert_eq!(timeout.to_string(), "failed to fetch model list: timeout");

        let http = fetch_provider_models(&key, access, &transport, FetchModelsOptions::default())
            .await
            .expect_err("HTTP status");
        assert_eq!(http.kind(), FetchModelsErrorKind::HttpStatus);
        let FetchModelsError::HttpStatus { body_excerpt, .. } = &http else {
            unreachable!("checked HTTP variant")
        };
        assert_eq!(body_excerpt.len(), DIAGNOSTIC_EXCERPT_BYTES);

        let invalid_json =
            fetch_provider_models(&key, access, &transport, FetchModelsOptions::default())
                .await
                .expect_err("invalid JSON");
        assert_eq!(invalid_json.kind(), FetchModelsErrorKind::InvalidJson);

        let shape = fetch_provider_models(&key, access, &transport, FetchModelsOptions::default())
            .await
            .expect_err("unexpected shape");
        assert_eq!(shape.kind(), FetchModelsErrorKind::UnexpectedShape);
    }
}
