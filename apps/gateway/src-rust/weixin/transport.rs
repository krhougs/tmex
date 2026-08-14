use std::fmt;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use rand::rngs::OsRng;
use rand::RngCore;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::{
    redact_known_secrets, truncate_utf16_units, BaseInfo, GetBotQrcodeResponse,
    GetQrcodeStatusResponse, GetUpdatesRequest, GetUpdatesResponse, MessageItem,
    SendMessageResponse, SendTextRequest, TextItem, WeixinBotToken, WeixinMessage,
    WeixinTransportError, CHANNEL_VERSION, ILINK_BOT_TYPE, ILINK_LOGIN_HOST, ITEM_TYPE_TEXT,
    MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT,
};

const HTTP_ERROR_EXCERPT_UTF16_UNITS: usize = 200;
const ENCODE_URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[async_trait]
pub trait WeixinIlinkTransport: Send + Sync {
    async fn get_bot_qrcode(&self) -> Result<GetBotQrcodeResponse, WeixinTransportError>;

    async fn get_qrcode_status(
        &self,
        qrcode: &str,
    ) -> Result<GetQrcodeStatusResponse, WeixinTransportError>;

    async fn get_updates(
        &self,
        request: GetUpdatesRequest,
    ) -> Result<GetUpdatesResponse, WeixinTransportError>;

    async fn send_message(
        &self,
        request: SendTextRequest,
    ) -> Result<SendMessageResponse, WeixinTransportError>;
}

#[derive(Clone)]
pub struct ReqwestWeixinIlinkTransport {
    client: reqwest::Client,
    login_host: String,
}

impl fmt::Debug for ReqwestWeixinIlinkTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReqwestWeixinIlinkTransport([REDACTED])")
    }
}

impl Default for ReqwestWeixinIlinkTransport {
    fn default() -> Self {
        Self::new(reqwest::Client::new())
    }
}

impl ReqwestWeixinIlinkTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            login_host: ILINK_LOGIN_HOST.to_owned(),
        }
    }

    fn build_get_bot_qrcode_request(&self) -> Result<reqwest::Request, WeixinTransportError> {
        let host = trim_one_trailing_slash(&self.login_host);
        self.client
            .get(format!(
                "{host}/ilink/bot/get_bot_qrcode?bot_type={ILINK_BOT_TYPE}"
            ))
            .headers(build_auth_headers(None)?)
            .build()
            .map_err(|_| WeixinTransportError::InvalidRequest)
    }

    fn build_get_qrcode_status_request(
        &self,
        qrcode: &str,
    ) -> Result<reqwest::Request, WeixinTransportError> {
        let host = trim_one_trailing_slash(&self.login_host);
        let qrcode = utf8_percent_encode(qrcode, ENCODE_URI_COMPONENT);
        self.client
            .get(format!(
                "{host}/ilink/bot/get_qrcode_status?qrcode={qrcode}"
            ))
            .headers(build_auth_headers(None)?)
            .build()
            .map_err(|_| WeixinTransportError::InvalidRequest)
    }

    fn build_get_updates_request(
        &self,
        request: &GetUpdatesRequest,
    ) -> Result<reqwest::Request, WeixinTransportError> {
        let base_url = trim_one_trailing_slash(request.credentials.base_url.expose_secret());
        let body = GetUpdatesBody {
            get_updates_buf: &request.get_updates_buf,
            base_info: channel_base_info(),
        };
        let body = serde_json::to_vec(&body).map_err(|_| WeixinTransportError::InvalidRequest)?;
        self.client
            .post(format!("{base_url}/ilink/bot/getupdates"))
            .headers(build_auth_headers(Some(&request.credentials.bot_token))?)
            .body(body)
            .build()
            .map_err(|_| WeixinTransportError::InvalidRequest)
    }

    fn build_send_message_request(
        &self,
        request: &SendTextRequest,
    ) -> Result<reqwest::Request, WeixinTransportError> {
        let base_url = trim_one_trailing_slash(request.credentials.base_url.expose_secret());
        let item_list = request
            .items
            .iter()
            .map(|text| MessageItem {
                r#type: Some(ITEM_TYPE_TEXT),
                text_item: Some(TextItem {
                    text: Some(text.clone()),
                }),
                ..MessageItem::default()
            })
            .collect();
        let body = SendMessageBody {
            msg: WeixinMessage {
                to_user_id: Some(request.to_user_id.clone()),
                client_id: Some(request.client_id.clone()),
                message_type: Some(MESSAGE_TYPE_BOT),
                message_state: Some(MESSAGE_STATE_FINISH),
                item_list: Some(item_list),
                context_token: Some(request.context_token.clone()),
                ..WeixinMessage::default()
            },
            base_info: channel_base_info(),
        };
        let body = serde_json::to_vec(&body).map_err(|_| WeixinTransportError::InvalidRequest)?;
        self.client
            .post(format!("{base_url}/ilink/bot/sendmessage"))
            .headers(build_auth_headers(Some(&request.credentials.bot_token))?)
            .body(body)
            .build()
            .map_err(|_| WeixinTransportError::InvalidRequest)
    }

    async fn execute<Response>(
        &self,
        request: reqwest::Request,
        secrets: &[&str],
    ) -> Result<Response, WeixinTransportError>
    where
        Response: DeserializeOwned,
    {
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| WeixinTransportError::Network)?;
        let status = response.status();
        let reason = status.canonical_reason().unwrap_or_default().to_owned();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(http_status_error(status.as_u16(), reason, &body, secrets));
        }
        let body = response
            .text()
            .await
            .map_err(|_| WeixinTransportError::Network)?;
        if body.is_empty() {
            return serde_json::from_str("{}").map_err(|_| WeixinTransportError::InvalidResponse);
        }
        serde_json::from_str(&body).map_err(|_| WeixinTransportError::InvalidResponse)
    }
}

#[async_trait]
impl WeixinIlinkTransport for ReqwestWeixinIlinkTransport {
    async fn get_bot_qrcode(&self) -> Result<GetBotQrcodeResponse, WeixinTransportError> {
        let request = self.build_get_bot_qrcode_request()?;
        self.execute(request, &[&self.login_host]).await
    }

    async fn get_qrcode_status(
        &self,
        qrcode: &str,
    ) -> Result<GetQrcodeStatusResponse, WeixinTransportError> {
        let request = self.build_get_qrcode_status_request(qrcode)?;
        self.execute(request, &[&self.login_host, qrcode]).await
    }

    async fn get_updates(
        &self,
        request: GetUpdatesRequest,
    ) -> Result<GetUpdatesResponse, WeixinTransportError> {
        let wire = self.build_get_updates_request(&request)?;
        self.execute(
            wire,
            &[
                request.credentials.bot_token.expose_secret(),
                request.credentials.base_url.expose_secret(),
                &request.get_updates_buf,
            ],
        )
        .await
    }

    async fn send_message(
        &self,
        request: SendTextRequest,
    ) -> Result<SendMessageResponse, WeixinTransportError> {
        let wire = self.build_send_message_request(&request)?;
        self.execute(
            wire,
            &[
                request.credentials.bot_token.expose_secret(),
                request.credentials.base_url.expose_secret(),
                &request.context_token,
            ],
        )
        .await
    }
}

#[derive(Serialize)]
struct GetUpdatesBody<'a> {
    get_updates_buf: &'a str,
    base_info: BaseInfo,
}

#[derive(Serialize)]
struct SendMessageBody {
    msg: WeixinMessage,
    base_info: BaseInfo,
}

fn channel_base_info() -> BaseInfo {
    BaseInfo {
        channel_version: Some(CHANNEL_VERSION.to_owned()),
    }
}

fn trim_one_trailing_slash(value: &str) -> &str {
    value.strip_suffix('/').unwrap_or(value)
}

fn http_status_error(
    status: u16,
    reason: String,
    body: &str,
    secrets: &[&str],
) -> WeixinTransportError {
    let redacted = redact_known_secrets(body, secrets);
    WeixinTransportError::HttpStatus {
        status,
        reason,
        excerpt: truncate_utf16_units(&redacted, HTTP_ERROR_EXCERPT_UTF16_UNITS),
    }
}

pub fn generate_wechat_uin() -> String {
    let decimal = OsRng.next_u32().to_string();
    STANDARD.encode(decimal.as_bytes())
}

fn build_auth_headers(
    bot_token: Option<&WeixinBotToken>,
) -> Result<HeaderMap, WeixinTransportError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("authorizationtype"),
        HeaderValue::from_static("ilink_bot_token"),
    );
    let uin = generate_wechat_uin();
    headers.insert(
        HeaderName::from_static("x-wechat-uin"),
        HeaderValue::from_str(&uin).map_err(|_| WeixinTransportError::InvalidRequest)?,
    );
    if let Some(token) = bot_token {
        let token = token.expose_secret().trim();
        if !token.is_empty() {
            let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| WeixinTransportError::InvalidRequest)?;
            headers.insert(AUTHORIZATION, authorization);
        }
    }
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weixin::{WeixinBaseUrl, WeixinCredentials};

    fn credentials() -> WeixinCredentials {
        WeixinCredentials {
            account_id: "account-1".to_owned(),
            bot_token: WeixinBotToken::new("token-secret"),
            base_url: WeixinBaseUrl::new("https://base.example/"),
        }
    }

    fn json_body(request: &reqwest::Request) -> serde_json::Value {
        serde_json::from_slice(
            request
                .body()
                .and_then(reqwest::Body::as_bytes)
                .expect("body"),
        )
        .expect("JSON body")
    }

    #[test]
    fn builds_all_four_ilink_wire_requests_without_exposing_secrets_in_debug() {
        let transport = ReqwestWeixinIlinkTransport::default();
        let qr = transport.build_get_bot_qrcode_request().expect("qrcode");
        assert_eq!(
            qr.url().as_str(),
            "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3"
        );
        assert_eq!(qr.method(), reqwest::Method::GET);
        assert!(qr.headers().get(AUTHORIZATION).is_none());

        let status = transport
            .build_get_qrcode_status_request("qr space/1")
            .expect("status");
        assert_eq!(
            status.url().as_str(),
            "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr%20space%2F1"
        );

        let updates = transport
            .build_get_updates_request(&GetUpdatesRequest {
                credentials: credentials(),
                get_updates_buf: "cursor-1".to_owned(),
            })
            .expect("updates");
        assert_eq!(
            updates.url().as_str(),
            "https://base.example/ilink/bot/getupdates"
        );
        assert_eq!(updates.headers()[AUTHORIZATION], "Bearer token-secret");
        let updates_body = json_body(&updates);
        assert_eq!(updates_body["get_updates_buf"], "cursor-1");
        assert_eq!(updates_body["base_info"]["channel_version"], "1.0.3");

        let send = transport
            .build_send_message_request(&SendTextRequest {
                credentials: credentials(),
                to_user_id: "user@im.wechat".to_owned(),
                context_token: "context-secret".to_owned(),
                client_id: "openclaw-weixin-deadbeef".to_owned(),
                items: vec!["hello".to_owned()],
            })
            .expect("send");
        assert_eq!(
            send.url().as_str(),
            "https://base.example/ilink/bot/sendmessage"
        );
        let send_body = json_body(&send);
        assert_eq!(send_body["msg"]["message_type"], 2);
        assert_eq!(send_body["msg"]["message_state"], 2);
        assert_eq!(send_body["msg"]["item_list"][0]["type"], 1);
        assert_eq!(
            send_body["msg"]["item_list"][0]["text_item"]["text"],
            "hello"
        );

        let uin = updates.headers()["x-wechat-uin"]
            .to_str()
            .expect("uin header");
        let decoded = STANDARD.decode(uin).expect("base64 uin");
        let decoded = String::from_utf8(decoded).expect("decimal uin");
        assert!(decoded.parse::<u32>().is_ok());

        let request_debug = format!(
            "{:?}",
            GetUpdatesRequest {
                credentials: credentials(),
                get_updates_buf: "cursor-secret".to_owned(),
            }
        );
        assert!(!request_debug.contains("token-secret"));
        assert!(!request_debug.contains("base.example"));
        assert!(!request_debug.contains("cursor-secret"));
        assert!(!format!("{transport:?}").contains("ilinkai.weixin.qq.com"));
        let confirmed = GetQrcodeStatusResponse {
            bot_token: Some("token-secret".to_owned()),
            baseurl: Some("https://base.example".to_owned()),
            errmsg: Some("token-secret".to_owned()),
            ..GetQrcodeStatusResponse::default()
        };
        let confirmed_debug = format!("{confirmed:?}");
        assert!(!confirmed_debug.contains("token-secret"));
        assert!(!confirmed_debug.contains("base.example"));
    }

    #[test]
    fn http_diagnostics_are_utf16_bounded_and_redact_known_credentials() {
        let raw = format!("token-secret https://base.example {}", "x".repeat(400));
        let error = http_status_error(
            502,
            "Bad Gateway".to_owned(),
            &raw,
            &["token-secret", "https://base.example"],
        );
        let diagnostic = format!("{error:?} {error}");
        assert!(!diagnostic.contains("token-secret"));
        assert!(!diagnostic.contains("base.example"));
        assert!(diagnostic.contains("502"));
    }
}
