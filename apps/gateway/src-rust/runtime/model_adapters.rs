use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::{redact_secrets, AgentModelDriver, AgentModelError};
use crate::crypto::MasterKey;
use crate::database::repository::Repository;
use crate::http::{WatchAssistRegexModelOutput, WatchAssistRegexModelRequest};
use crate::llm::{
    LanguageModelGenerator, OpenAiAgentModelDriver, ProviderRegistry, StructuredJsonRequest,
};
use crate::watch::{
    WatchLlmOperation, WatchLlmRequest, WatchLlmResponse, WatchModelGenerator, WatchRuntimeError,
};

use super::ports::{GatewayRuntimePortError, WatchAssistRegexGenerator};

#[derive(Clone)]
pub struct GatewayStructuredModelAdapter {
    registry: ProviderRegistry,
    generator: Arc<dyn LanguageModelGenerator>,
}

impl GatewayStructuredModelAdapter {
    pub fn new(registry: ProviderRegistry, generator: Arc<dyn LanguageModelGenerator>) -> Self {
        Self {
            registry,
            generator,
        }
    }

    async fn generate(
        &self,
        provider_id: Option<&str>,
        model_id: Option<&str>,
        prompt: String,
        max_retries: u32,
        operation: StructuredModelOperation,
    ) -> Result<Value, StructuredModelAdapterError> {
        let endpoint = self
            .registry
            .resolve_language_model(provider_id, model_id)
            .await
            .map_err(|error| StructuredModelAdapterError::Provider(safe_error(error)))?;
        let mut request = StructuredJsonRequest::from_prompt(endpoint, prompt, operation.schema());
        request.name = operation.schema_name().to_owned();
        request.description = Some(operation.schema_description().to_owned());
        request.text.max_retries = max_retries;
        self.generator
            .generate_structured_json(request)
            .await
            .map_err(|error| StructuredModelAdapterError::Generation(safe_model_error(&error)))
    }
}

#[async_trait]
impl WatchModelGenerator for GatewayStructuredModelAdapter {
    async fn generate(
        &self,
        request: WatchLlmRequest,
    ) -> Result<WatchLlmResponse, WatchRuntimeError> {
        let operation = StructuredModelOperation::from(request.operation);
        let value = self
            .generate(
                request.provider_id.as_deref(),
                request.model_id.as_deref(),
                request.prompt,
                request.max_retries,
                operation,
            )
            .await
            .map_err(|error| WatchRuntimeError::new(error.to_string()))?;
        parse_watch_response(operation, &value)
            .map_err(|_| WatchRuntimeError::new(operation.invalid_response_message()))
    }
}

#[async_trait]
impl WatchAssistRegexGenerator for GatewayStructuredModelAdapter {
    async fn generate(
        &self,
        request: WatchAssistRegexModelRequest,
    ) -> Result<WatchAssistRegexModelOutput, GatewayRuntimePortError> {
        let operation = StructuredModelOperation::AssistRegex;
        let value = self
            .generate(
                request.provider_id.as_deref(),
                request.model_id.as_deref(),
                request.prompt,
                request.max_retries,
                operation,
            )
            .await
            .map_err(|error| GatewayRuntimePortError::new(error.to_string()))?;
        parse_assist_response(&value)
            .map_err(|_| GatewayRuntimePortError::new(operation.invalid_response_message()))
    }
}

#[derive(Clone)]
pub struct GatewayLanguageModelAdapters {
    driver: Arc<OpenAiAgentModelDriver>,
    structured: Arc<GatewayStructuredModelAdapter>,
}

impl GatewayLanguageModelAdapters {
    pub fn production(repository: Repository, master_key: MasterKey) -> Self {
        let driver = Arc::new(OpenAiAgentModelDriver::default());
        let structured = Arc::new(GatewayStructuredModelAdapter::new(
            ProviderRegistry::new(repository, master_key),
            driver.clone(),
        ));
        Self { driver, structured }
    }

    pub fn driver(&self) -> Arc<OpenAiAgentModelDriver> {
        self.driver.clone()
    }

    pub fn structured(&self) -> Arc<GatewayStructuredModelAdapter> {
        self.structured.clone()
    }

    pub fn agent_model(&self) -> Arc<dyn AgentModelDriver> {
        self.driver.clone()
    }

    pub fn watch_model(&self) -> Arc<dyn WatchModelGenerator> {
        self.structured.clone()
    }

    pub fn watch_assist(&self) -> Arc<dyn WatchAssistRegexGenerator> {
        self.structured.clone()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StructuredModelOperation {
    Confirm,
    Summary,
    Judge,
    AssistRegex,
}

impl StructuredModelOperation {
    fn schema_name(self) -> &'static str {
        match self {
            Self::Confirm => "watch_confirm",
            Self::Summary => "watch_summary",
            Self::Judge => "watch_judge",
            Self::AssistRegex => "watch_assist_regex",
        }
    }

    fn schema_description(self) -> &'static str {
        match self {
            Self::Confirm => "Confirm whether the observed terminal condition is satisfied.",
            Self::Summary => "Summarize the observed terminal condition.",
            Self::Judge => "Judge whether the terminal watch condition is satisfied.",
            Self::AssistRegex => "Generate a regular expression for a terminal watch rule.",
        }
    }

    fn schema(self) -> Value {
        let properties = match self {
            Self::Confirm => json!({
                "confirmed": { "type": "boolean" },
                "reason": { "type": "string" }
            }),
            Self::Summary => json!({
                "summary": { "type": "string" }
            }),
            Self::Judge => json!({
                "matched": { "type": "boolean" },
                "reason": { "type": "string" }
            }),
            Self::AssistRegex => json!({
                "pattern": { "type": "string" },
                "flags": { "type": "string" },
                "extractGroup": { "type": "integer" },
                "explanation": { "type": "string" }
            }),
        };
        let required = match self {
            Self::Confirm => json!(["confirmed", "reason"]),
            Self::Summary => json!(["summary"]),
            Self::Judge => json!(["matched", "reason"]),
            Self::AssistRegex => {
                json!(["pattern", "flags", "extractGroup", "explanation"])
            }
        };
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        })
    }

    fn invalid_response_message(self) -> &'static str {
        match self {
            Self::Confirm => "watch model returned an invalid confirmation response",
            Self::Summary => "watch model returned an invalid summary response",
            Self::Judge => "watch model returned an invalid judgment response",
            Self::AssistRegex => "watch model returned an invalid regular-expression response",
        }
    }
}

impl From<WatchLlmOperation> for StructuredModelOperation {
    fn from(value: WatchLlmOperation) -> Self {
        match value {
            WatchLlmOperation::Confirm => Self::Confirm,
            WatchLlmOperation::Summary => Self::Summary,
            WatchLlmOperation::Judge => Self::Judge,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum StructuredModelAdapterError {
    #[error("failed to resolve language model: {0}")]
    Provider(String),
    #[error("language model generation failed: {0}")]
    Generation(String),
}

fn parse_watch_response(
    operation: StructuredModelOperation,
    value: &Value,
) -> Result<WatchLlmResponse, ()> {
    match operation {
        StructuredModelOperation::Confirm => Ok(WatchLlmResponse::Confirm {
            confirmed: required_bool(value, "confirmed")?,
            reason: required_string(value, "reason")?,
        }),
        StructuredModelOperation::Summary => Ok(WatchLlmResponse::Summary {
            summary: required_string(value, "summary")?,
        }),
        StructuredModelOperation::Judge => Ok(WatchLlmResponse::Judge {
            matched: required_bool(value, "matched")?,
            reason: required_string(value, "reason")?,
        }),
        StructuredModelOperation::AssistRegex => Err(()),
    }
}

fn parse_assist_response(value: &Value) -> Result<WatchAssistRegexModelOutput, ()> {
    Ok(WatchAssistRegexModelOutput {
        pattern: required_string(value, "pattern")?,
        flags: required_string(value, "flags")?,
        extract_group: required_i64(value, "extractGroup")?,
        explanation: required_string(value, "explanation")?,
    })
}

fn required_bool(value: &Value, field: &str) -> Result<bool, ()> {
    value.get(field).and_then(Value::as_bool).ok_or(())
}

fn required_string(value: &Value, field: &str) -> Result<String, ()> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(())
}

fn required_i64(value: &Value, field: &str) -> Result<i64, ()> {
    value.get(field).and_then(Value::as_i64).ok_or(())
}

fn safe_error(error: impl std::fmt::Display) -> String {
    redact_secrets(&error.to_string()).text
}

fn safe_model_error(error: &AgentModelError) -> String {
    redact_secrets(error.message()).text
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tmex_db::DbConfig;

    use crate::database::repository::{AgentSettingsUpdate, CreateLlmProviderInput};
    use crate::database::DatabaseBootstrap;
    use crate::llm::{PrivateNetworkPolicy, TextGenerationRequest};

    use super::*;

    #[derive(Default)]
    struct RecordingGenerator {
        request: Mutex<Option<(String, String, String, u32)>>,
    }

    #[async_trait]
    impl LanguageModelGenerator for RecordingGenerator {
        async fn generate_text(
            &self,
            _request: TextGenerationRequest,
        ) -> Result<String, AgentModelError> {
            Err(AgentModelError::new("unused text generation", false))
        }

        async fn generate_structured_json(
            &self,
            request: StructuredJsonRequest,
        ) -> Result<Value, AgentModelError> {
            *self.request.lock().expect("recorded model request lock") = Some((
                request.text.endpoint.provider_id,
                request.text.endpoint.model_id,
                request.name,
                request.text.max_retries,
            ));
            Ok(json!({ "confirmed": true, "reason": "ready" }))
        }
    }

    #[test]
    fn schemas_and_response_validation_match_watch_and_assist_contracts() {
        assert_eq!(
            StructuredModelOperation::Confirm.schema(),
            json!({
                "type": "object",
                "properties": {
                    "confirmed": { "type": "boolean" },
                    "reason": { "type": "string" }
                },
                "required": ["confirmed", "reason"],
                "additionalProperties": false
            })
        );
        assert_eq!(
            parse_watch_response(
                StructuredModelOperation::Confirm,
                &json!({ "confirmed": true, "reason": "yes" }),
            ),
            Ok(WatchLlmResponse::Confirm {
                confirmed: true,
                reason: "yes".to_owned(),
            })
        );
        assert_eq!(
            parse_watch_response(
                StructuredModelOperation::Summary,
                &json!({ "summary": "done" }),
            ),
            Ok(WatchLlmResponse::Summary {
                summary: "done".to_owned(),
            })
        );
        assert_eq!(
            parse_watch_response(
                StructuredModelOperation::Judge,
                &json!({ "matched": false, "reason": "waiting" }),
            ),
            Ok(WatchLlmResponse::Judge {
                matched: false,
                reason: "waiting".to_owned(),
            })
        );
        assert_eq!(
            parse_assist_response(&json!({
                "pattern": "error",
                "flags": "i",
                "extractGroup": 1,
                "explanation": "match errors"
            })),
            Ok(WatchAssistRegexModelOutput {
                pattern: "error".to_owned(),
                flags: "i".to_owned(),
                extract_group: 1,
                explanation: "match errors".to_owned(),
            })
        );
        assert!(parse_watch_response(
            StructuredModelOperation::Judge,
            &json!({ "matched": "yes", "reason": "wrong type" }),
        )
        .is_err());
        assert!(parse_assist_response(&json!({
            "pattern": "x",
            "flags": "",
            "extractGroup": 1.5,
            "explanation": "not an integer"
        }))
        .is_err());
    }

    #[tokio::test]
    async fn resolves_default_provider_and_keeps_private_openai_compatibility() {
        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .expect("bootstrap model adapter database");
        let repository = Repository::new(database);
        let key = MasterKey::development_default();
        let provider = repository
            .create_llm_provider(CreateLlmProviderInput {
                name: "Local compatible provider".to_owned(),
                protocol: "openai-chat".to_owned(),
                base_url: "http://127.0.0.1:11434".to_owned(),
                api_key_enc: key.encrypt("local-secret").expect("encrypt provider key"),
                enabled: Some(true),
            })
            .await
            .expect("create provider");
        repository
            .update_agent_settings(AgentSettingsUpdate {
                default_provider_id: Some(Some(provider.id.clone())),
                default_model_id: Some(Some("local-model".to_owned())),
                ..AgentSettingsUpdate::default()
            })
            .await
            .expect("configure default model");
        let generator = Arc::new(RecordingGenerator::default());
        let adapter = GatewayStructuredModelAdapter::new(
            ProviderRegistry::new(repository.clone(), key.clone()),
            generator.clone(),
        );

        let response = WatchModelGenerator::generate(
            &adapter,
            WatchLlmRequest {
                operation: WatchLlmOperation::Confirm,
                provider_id: None,
                model_id: None,
                prompt: "confirm".to_owned(),
                max_retries: 4,
            },
        )
        .await
        .expect("generate with defaults");
        assert_eq!(
            response,
            WatchLlmResponse::Confirm {
                confirmed: true,
                reason: "ready".to_owned(),
            }
        );
        assert_eq!(
            *generator.request.lock().expect("recorded request lock"),
            Some((
                provider.id,
                "local-model".to_owned(),
                "watch_confirm".to_owned(),
                4,
            ))
        );

        let production = GatewayLanguageModelAdapters::production(repository, key);
        assert_eq!(
            production.driver().transport().policy().private_network,
            PrivateNetworkPolicy::AllowPrivate
        );
    }
}
