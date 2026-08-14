use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    TelegramBotToken, TelegramGetUpdatesBody, TelegramGetUpdatesRequest, TelegramSendMessageBody,
    TelegramSendMessageRequest, TelegramTransportError, TelegramUpdate,
};

#[async_trait]
pub trait TelegramBotTransport: Send + Sync {
    async fn validate_bot(&self) -> Result<(), TelegramTransportError>;
    async fn get_updates(
        &self,
        request: TelegramGetUpdatesRequest,
    ) -> Result<Vec<TelegramUpdate>, TelegramTransportError>;
    async fn send_message(
        &self,
        request: TelegramSendMessageRequest,
    ) -> Result<(), TelegramTransportError>;
}

pub trait TelegramTransportFactory: Send + Sync {
    fn create(&self, token: TelegramBotToken) -> Arc<dyn TelegramBotTransport>;
}

#[derive(Clone, Debug)]
pub struct ReqwestTelegramTransportFactory {
    client: reqwest::Client,
    api_base: String,
}

impl Default for ReqwestTelegramTransportFactory {
    fn default() -> Self {
        Self::new(reqwest::Client::new())
    }
}

impl ReqwestTelegramTransportFactory {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            api_base: "https://api.telegram.org".to_owned(),
        }
    }
}

impl TelegramTransportFactory for ReqwestTelegramTransportFactory {
    fn create(&self, token: TelegramBotToken) -> Arc<dyn TelegramBotTransport> {
        Arc::new(ReqwestTelegramBotTransport {
            client: self.client.clone(),
            api_root: format!(
                "{}/bot{}",
                self.api_base.trim_end_matches('/'),
                token.expose_secret()
            ),
        })
    }
}

struct ReqwestTelegramBotTransport {
    client: reqwest::Client,
    api_root: String,
}

impl fmt::Debug for ReqwestTelegramBotTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReqwestTelegramBotTransport([REDACTED])")
    }
}

#[derive(Deserialize)]
struct TelegramApiResponse<T> {
    ok: bool,
    result: Option<T>,
}

impl ReqwestTelegramBotTransport {
    async fn post<Request, Response>(
        &self,
        method: &str,
        body: &Request,
    ) -> Result<Response, TelegramTransportError>
    where
        Request: serde::Serialize + Sync,
        Response: DeserializeOwned,
    {
        let body = serde_json::to_vec(body).map_err(|_| TelegramTransportError::InvalidResponse)?;
        let response = self
            .client
            .post(format!("{}/{method}", self.api_root))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| TelegramTransportError::Network)?;
        if !response.status().is_success() {
            return Err(TelegramTransportError::HttpStatus(
                response.status().as_u16(),
            ));
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| TelegramTransportError::Network)?;
        let response: TelegramApiResponse<Response> =
            serde_json::from_slice(&body).map_err(|_| TelegramTransportError::InvalidResponse)?;
        if !response.ok {
            return Err(TelegramTransportError::ApiRejected);
        }
        response
            .result
            .ok_or(TelegramTransportError::InvalidResponse)
    }
}

#[async_trait]
impl TelegramBotTransport for ReqwestTelegramBotTransport {
    async fn validate_bot(&self) -> Result<(), TelegramTransportError> {
        let _: serde_json::Value = self.post("getMe", &serde_json::json!({})).await?;
        Ok(())
    }

    async fn get_updates(
        &self,
        request: TelegramGetUpdatesRequest,
    ) -> Result<Vec<TelegramUpdate>, TelegramTransportError> {
        self.post(
            "getUpdates",
            &TelegramGetUpdatesBody {
                offset: request.offset,
                timeout: request.timeout_seconds,
            },
        )
        .await
    }

    async fn send_message(
        &self,
        request: TelegramSendMessageRequest,
    ) -> Result<(), TelegramTransportError> {
        let _: serde_json::Value = self
            .post(
                "sendMessage",
                &TelegramSendMessageBody {
                    chat_id: &request.chat_id,
                    text: &request.text,
                    parse_mode: request.parse_mode.map(|mode| mode.as_api_value()),
                },
            )
            .await?;
        Ok(())
    }
}
