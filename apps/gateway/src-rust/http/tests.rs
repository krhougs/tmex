use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use http::{Method, Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tmex_db::DbConfig;
use tmex_protocol::WatchEvent;

use crate::agent::{AgentError, AgentPortError, SubmitUserMessageResult};
use crate::config::{GatewayConfig, GatewayEntryMode, GatewayPlatform};
use crate::crypto::{CryptoContext, MasterKey};
use crate::database::repository::{
    AgentConfirmationDecision, AgentSettingsUpdate, CreateAgentConfirmationInput,
    CreateAgentSessionInput, CreateLlmProviderInput, CreatePendingTelegramChatInput, Repository,
    RepositorySiteSettingsDefaults, UpsertWeixinUserInput, WeixinAccountUpdate,
};
use crate::database::DatabaseBootstrap;
use crate::entity::{
    agent_confirmations, agent_queued_messages, devices, telegram_bots, weixin_accounts,
};
use crate::events::{EventDraft, EventType};
use crate::files::{
    FileErrorCode, FileRuntime, FileRuntimeError, PreparedRsyncDevice, RsyncRequest, RsyncResult,
};
use crate::llm::{
    ModelsHttpFuture, ModelsHttpRequest, ModelsHttpResponse, ModelsHttpTransport,
    ModelsHttpTransportError,
};
use crate::system::update_check::{RegistryPackument, UpdateRegistry, UpdateRegistryError};
use crate::system::upgrade::{UpgradeController, UpgradeRunError, UpgradeRunner};
use crate::watch::{
    WatchDevice, WatchDeviceListener, WatchFuture, WatchIntervalCallback, WatchLlmRequest,
    WatchLlmResponse, WatchRuntime, WatchRuntimeError, WatchSchedule, WatchService,
    WatchServiceConfig, WatchSubscription,
};
use crate::weixin::{StartWeixinLoginResponse, WeixinLoginStatus, WeixinLoginStatusResponse};

use super::{
    AgentHttpService, ConnectionTestResult, HttpHandler, HttpRuntime, HttpRuntimeResult,
    SettingsNamespace, StateSnapshot, SystemInfo, TelegramHttpError, TelegramHttpService,
    ThemeMode, TmuxHealth, TreeCustomNames, TreeOrderChange, WatchAssistRegexModelOutput,
    WatchAssistRegexModelRequest, WeixinHttpError, WeixinHttpService,
};

#[derive(Default)]
struct TestRuntime {
    settings_changes: Mutex<Vec<SettingsNamespace>>,
    telegram_sequence: Mutex<Vec<String>>,
    weixin_sequence: Mutex<Vec<String>>,
    can_self_update: AtomicBool,
}
struct TestFileRuntime;
struct TestModelsTransport {
    requests: Mutex<Vec<ModelsHttpRequest>>,
    responses: Mutex<VecDeque<Result<ModelsHttpResponse, ModelsHttpTransportError>>>,
}
struct TestWatchRuntime;
struct TestWatchDevice;
struct TestWatchSchedule;
struct TestWatchSubscription;

struct TestAgentService {
    repository: Repository,
    active: Mutex<HashSet<String>>,
    stopped: Mutex<Vec<String>>,
    saw_session_during_stop: Mutex<bool>,
    submit_errors: Mutex<VecDeque<AgentError>>,
    confirmation_errors: Mutex<VecDeque<AgentError>>,
}

struct TestTelegramService {
    runtime: Arc<TestRuntime>,
    fail_refresh: AtomicBool,
    fail_send: AtomicBool,
    sent_messages: Mutex<Vec<(String, String, String)>>,
}

struct TestWeixinService {
    runtime: Arc<TestRuntime>,
    fail_refresh: AtomicBool,
    fail_send: AtomicBool,
    fail_start: AtomicBool,
    login_status: Mutex<WeixinLoginStatusResponse>,
    sent_messages: Mutex<Vec<(String, Option<String>, String)>>,
}

impl TestWeixinService {
    fn new(runtime: Arc<TestRuntime>) -> Self {
        Self {
            runtime,
            fail_refresh: AtomicBool::new(false),
            fail_send: AtomicBool::new(false),
            fail_start: AtomicBool::new(false),
            login_status: Mutex::new(WeixinLoginStatusResponse {
                status: WeixinLoginStatus::Pending,
                logged_in: false,
                message: None,
            }),
            sent_messages: Mutex::new(Vec::new()),
        }
    }

    fn clear_sequence(&self) {
        self.runtime
            .weixin_sequence
            .lock()
            .expect("Weixin HTTP sequence lock")
            .clear();
    }

    fn sequence(&self) -> Vec<String> {
        self.runtime
            .weixin_sequence
            .lock()
            .expect("Weixin HTTP sequence lock")
            .clone()
    }
}

#[async_trait]
impl WeixinHttpService for TestWeixinService {
    async fn refresh(&self) -> Result<(), WeixinHttpError> {
        self.runtime
            .weixin_sequence
            .lock()
            .expect("Weixin HTTP sequence lock")
            .push("refresh".to_owned());
        if self.fail_refresh.swap(false, Ordering::SeqCst) {
            return Err(WeixinHttpError::operation_failed());
        }
        Ok(())
    }

    async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError> {
        self.runtime
            .weixin_sequence
            .lock()
            .expect("Weixin HTTP sequence lock")
            .push(format!("send:{user_id}"));
        self.sent_messages
            .lock()
            .expect("Weixin test messages lock")
            .push((
                account_id.to_owned(),
                Some(user_id.to_owned()),
                text.to_owned(),
            ));
        if self.fail_send.swap(false, Ordering::SeqCst) {
            return Err(WeixinHttpError::operation_failed());
        }
        Ok(())
    }

    async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinHttpError> {
        self.runtime
            .weixin_sequence
            .lock()
            .expect("Weixin HTTP sequence lock")
            .push(format!("send-bound:{account_id}"));
        self.sent_messages
            .lock()
            .expect("Weixin test messages lock")
            .push((account_id.to_owned(), None, text.to_owned()));
        if self.fail_send.swap(false, Ordering::SeqCst) {
            return Err(WeixinHttpError::operation_failed());
        }
        Ok(())
    }

    async fn start_login(
        &self,
        _account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinHttpError> {
        if self.fail_start.swap(false, Ordering::SeqCst) {
            return Err(WeixinHttpError::operation_failed());
        }
        Ok(StartWeixinLoginResponse {
            qrcode_url: "weixin-qr-url".to_owned(),
            qrcode_id: "weixin-qr-id".to_owned(),
        })
    }

    async fn get_login_status(
        &self,
        _account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinHttpError> {
        Ok(self
            .login_status
            .lock()
            .expect("Weixin login status lock")
            .clone())
    }
}

impl TestTelegramService {
    fn new(runtime: Arc<TestRuntime>) -> Self {
        Self {
            runtime,
            fail_refresh: AtomicBool::new(false),
            fail_send: AtomicBool::new(false),
            sent_messages: Mutex::new(Vec::new()),
        }
    }

    fn clear_sequence(&self) {
        self.runtime
            .telegram_sequence
            .lock()
            .expect("Telegram HTTP sequence lock")
            .clear();
    }

    fn sequence(&self) -> Vec<String> {
        self.runtime
            .telegram_sequence
            .lock()
            .expect("Telegram HTTP sequence lock")
            .clone()
    }
}

#[async_trait]
impl TelegramHttpService for TestTelegramService {
    async fn refresh(&self) -> Result<(), TelegramHttpError> {
        self.runtime
            .telegram_sequence
            .lock()
            .expect("Telegram HTTP sequence lock")
            .push("refresh".to_owned());
        if self.fail_refresh.swap(false, Ordering::SeqCst) {
            return Err(TelegramHttpError);
        }
        Ok(())
    }

    async fn send_test_message(
        &self,
        bot_id: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<(), TelegramHttpError> {
        self.runtime
            .telegram_sequence
            .lock()
            .expect("Telegram HTTP sequence lock")
            .push(format!("send:{chat_id}"));
        self.sent_messages
            .lock()
            .expect("Telegram test messages lock")
            .push((bot_id.to_owned(), chat_id.to_owned(), text.to_owned()));
        if self.fail_send.swap(false, Ordering::SeqCst) {
            return Err(TelegramHttpError);
        }
        Ok(())
    }
}

impl TestAgentService {
    fn new(repository: Repository) -> Self {
        Self {
            repository,
            active: Mutex::new(HashSet::new()),
            stopped: Mutex::new(Vec::new()),
            saw_session_during_stop: Mutex::new(false),
            submit_errors: Mutex::new(VecDeque::new()),
            confirmation_errors: Mutex::new(VecDeque::new()),
        }
    }

    fn mark_active(&self, session_id: &str) {
        self.active
            .lock()
            .expect("active agent sessions lock")
            .insert(session_id.to_owned());
    }

    fn push_submit_error(&self, error: AgentError) {
        self.submit_errors
            .lock()
            .expect("agent submit errors lock")
            .push_back(error);
    }

    fn push_confirmation_error(&self, error: AgentError) {
        self.confirmation_errors
            .lock()
            .expect("agent confirmation errors lock")
            .push_back(error);
    }
}

impl TestModelsTransport {
    fn new(
        responses: impl IntoIterator<Item = Result<ModelsHttpResponse, ModelsHttpTransportError>>,
    ) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(responses.into_iter().collect()),
        }
    }

    fn request_count(&self) -> usize {
        self.requests.lock().expect("request lock").len()
    }
}

impl ModelsHttpTransport for TestModelsTransport {
    fn get(&self, request: ModelsHttpRequest) -> ModelsHttpFuture<'_> {
        self.requests.lock().expect("request lock").push(request);
        let response = self
            .responses
            .lock()
            .expect("response lock")
            .pop_front()
            .expect("fake models response");
        Box::pin(async move { response })
    }
}

fn models_response(status: u16, body: impl Into<Vec<u8>>) -> ModelsHttpResponse {
    ModelsHttpResponse {
        status,
        status_text: if status == 200 {
            "OK".to_owned()
        } else {
            "Internal Server Error".to_owned()
        },
        body: body.into(),
    }
}

impl WatchSchedule for TestWatchSchedule {
    fn cancel(&self) {}
}

impl WatchSubscription for TestWatchSubscription {
    fn detach(&self) {}
}

#[async_trait]
impl WatchDevice for TestWatchDevice {
    async fn connect(&self) -> Result<(), WatchRuntimeError> {
        Ok(())
    }

    async fn capture_pane_text(&self, _pane_id: &str) -> Result<String, WatchRuntimeError> {
        Ok(String::new())
    }

    fn subscribe(
        &self,
        _listener: Arc<dyn WatchDeviceListener>,
    ) -> Result<Arc<dyn WatchSubscription>, WatchRuntimeError> {
        Ok(Arc::new(TestWatchSubscription))
    }

    fn request_snapshot(&self) -> Result<(), WatchRuntimeError> {
        Ok(())
    }
}

#[async_trait]
impl WatchRuntime for TestWatchRuntime {
    fn now(&self) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-12T12:00:00.000Z")
            .expect("test timestamp")
            .with_timezone(&Utc)
    }

    fn schedule_interval(
        &self,
        _interval: Duration,
        _callback: WatchIntervalCallback,
    ) -> Result<Arc<dyn WatchSchedule>, WatchRuntimeError> {
        Ok(Arc::new(TestWatchSchedule))
    }

    fn spawn(&self, future: WatchFuture) {
        tokio::spawn(future);
    }

    async fn acquire_device(
        &self,
        _device_id: &str,
    ) -> Result<Arc<dyn WatchDevice>, WatchRuntimeError> {
        Ok(Arc::new(TestWatchDevice))
    }

    async fn release_device(
        &self,
        _device_id: &str,
        _device: Arc<dyn WatchDevice>,
    ) -> Result<(), WatchRuntimeError> {
        Ok(())
    }

    async fn generate(
        &self,
        _request: WatchLlmRequest,
    ) -> Result<WatchLlmResponse, WatchRuntimeError> {
        Err(WatchRuntimeError::new(
            "watch LLM runtime is not used by HTTP tests",
        ))
    }

    async fn notify(
        &self,
        _event_type: EventType,
        _event: EventDraft,
    ) -> Result<(), WatchRuntimeError> {
        Ok(())
    }

    fn broadcast(&self, _event: WatchEvent) -> Result<(), WatchRuntimeError> {
        Ok(())
    }
}

#[async_trait]
impl FileRuntime for TestFileRuntime {
    async fn prepare_rsync(
        &self,
        _device: &devices::Model,
    ) -> Result<PreparedRsyncDevice, FileRuntimeError> {
        Ok(PreparedRsyncDevice::local())
    }

    async fn run_rsync(&self, _request: RsyncRequest) -> Result<RsyncResult, FileRuntimeError> {
        Err(FileRuntimeError::new(
            FileErrorCode::Unknown,
            "file runtime is not used by these tests",
        ))
    }
}

fn test_agent_port_error(error: impl std::fmt::Display) -> AgentError {
    AgentPortError::new(error.to_string()).into()
}

#[async_trait]
impl AgentHttpService for TestAgentService {
    fn is_session_active(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .expect("active agent sessions lock")
            .contains(session_id)
    }

    async fn submit_user_message(
        &self,
        session_id: &str,
        text: &str,
        _steer: bool,
    ) -> Result<SubmitUserMessageResult, AgentError> {
        if let Some(error) = self
            .submit_errors
            .lock()
            .expect("agent submit errors lock")
            .pop_front()
        {
            return Err(error);
        }
        if self.is_session_active(session_id) {
            let queued = self
                .repository
                .enqueue_agent_message(session_id, text)
                .await
                .map_err(test_agent_port_error)?;
            return Ok(SubmitUserMessageResult::Queued {
                id: queued.id,
                seq: queued.seq,
            });
        }
        let message = self
            .repository
            .append_agent_message(
                session_id,
                "user",
                json!({ "role": "user", "content": text }),
            )
            .await
            .map_err(test_agent_port_error)?;
        Ok(SubmitUserMessageResult::Message {
            id: message.id,
            seq: message.seq,
        })
    }

    async fn edit_queued_message(
        &self,
        item_id: &str,
        text: &str,
    ) -> Result<agent_queued_messages::Model, AgentError> {
        self.repository
            .update_queued_agent_message(item_id, text)
            .await
            .map_err(test_agent_port_error)?
            .ok_or(AgentError::QueuedMessageNotFound)
    }

    async fn withdraw_queued_message(&self, item_id: &str) -> Result<(), AgentError> {
        if self
            .repository
            .get_queued_agent_message_by_id(item_id)
            .await
            .map_err(test_agent_port_error)?
            .is_none()
        {
            return Err(AgentError::QueuedMessageNotFound);
        }
        self.repository
            .delete_queued_agent_message(item_id)
            .await
            .map_err(test_agent_port_error)
    }

    async fn stop_session(&self, session_id: &str) -> Result<(), AgentError> {
        let exists = self
            .repository
            .get_agent_session_by_id(session_id)
            .await
            .map_err(test_agent_port_error)?
            .is_some();
        *self
            .saw_session_during_stop
            .lock()
            .expect("stop ordering lock") = exists;
        if !exists {
            return Err(AgentError::SessionNotFound);
        }
        self.active
            .lock()
            .expect("active agent sessions lock")
            .remove(session_id);
        self.stopped
            .lock()
            .expect("stopped agent sessions lock")
            .push(session_id.to_owned());
        Ok(())
    }

    async fn resolve_confirmation(
        &self,
        confirmation_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> Result<agent_confirmations::Model, AgentError> {
        if let Some(error) = self
            .confirmation_errors
            .lock()
            .expect("agent confirmation errors lock")
            .pop_front()
        {
            return Err(error);
        }
        let Some(existing) = self
            .repository
            .get_agent_confirmation_by_id(confirmation_id)
            .await
            .map_err(test_agent_port_error)?
        else {
            return Err(AgentError::ConfirmationNotFound);
        };
        if existing.status != "pending" {
            return Err(AgentError::ConfirmationAlreadyDecided);
        }
        self.repository
            .decide_agent_confirmation(
                confirmation_id,
                AgentConfirmationDecision {
                    status: if approved { "approved" } else { "denied" }.to_owned(),
                    reason,
                },
            )
            .await
            .map_err(test_agent_port_error)?
            .ok_or(AgentError::ConfirmationAlreadyDecided)
    }
}

#[async_trait]
impl HttpRuntime for TestRuntime {
    fn translate(&self, key: &'static str) -> String {
        match key {
            "apiError.llmFetchModelsFailed" => "Failed to fetch model list: {{detail}}".to_owned(),
            "telegram.approveMessageTemplate" => {
                "Authorized bot {{botName}} at {{time}}".to_owned()
            }
            "telegram.testMessageTemplate" => {
                "Test message for {{siteName}} at {{time}}".to_owned()
            }
            "weixin.approveMessageTemplate" => {
                "Authorized account {{accountName}} at {{time}}".to_owned()
            }
            "weixin.testMessageTemplate" => "Weixin test for {{siteName}} at {{time}}".to_owned(),
            _ => key.to_owned(),
        }
    }

    fn tree_overlay_available(&self) -> bool {
        true
    }

    fn is_restarting(&self) -> bool {
        false
    }

    async fn upsert_device(&self, _device_id: &str) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn reconnect_device(&self, _device_id: &str) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn remove_device(&self, _device_id: &str) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn update_default_working_dir(
        &self,
        _device_id: &str,
        _working_dir: Option<String>,
    ) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn clear_connection_alert(&self, _device_id: &str) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn test_connection(&self, _device_id: &str) -> HttpRuntimeResult<ConnectionTestResult> {
        Ok(ConnectionTestResult {
            success: true,
            tmux_available: true,
            phase: "ready".to_owned(),
            error_type: None,
            message: Some("common.success".to_owned()),
            raw_message: None,
        })
    }

    async fn latest_snapshot(&self, _device_id: &str) -> HttpRuntimeResult<Option<StateSnapshot>> {
        Ok(None)
    }

    async fn watch_capture_screen(
        &self,
        _device_id: &str,
        _pane_id: &str,
    ) -> HttpRuntimeResult<String> {
        Ok("downloading 73%\nplease wait\n".to_owned())
    }

    async fn watch_assist_regex(
        &self,
        _request: WatchAssistRegexModelRequest,
    ) -> HttpRuntimeResult<WatchAssistRegexModelOutput> {
        Ok(WatchAssistRegexModelOutput {
            pattern: "(\\d+)%".to_owned(),
            flags: String::new(),
            extract_group: 1,
            explanation: "matches percentage".to_owned(),
        })
    }

    async fn agent_origin_process_name(
        &self,
        _device_id: &str,
        _pane_id: &str,
    ) -> HttpRuntimeResult<Option<String>> {
        Ok(Some("test-shell".to_owned()))
    }

    async fn tree_custom_names(
        &self,
        _device_id: &str,
    ) -> HttpRuntimeResult<Option<TreeCustomNames>> {
        Ok(None)
    }

    async fn tree_order_changed(&self, _change: TreeOrderChange) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn rename_window(
        &self,
        _device_id: &str,
        _window_id: &str,
        _name: Option<String>,
    ) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn rename_pane(
        &self,
        _device_id: &str,
        _pane_id: &str,
        _name: Option<String>,
    ) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn settings_changed(&self, namespace: SettingsNamespace) -> HttpRuntimeResult<()> {
        if namespace == SettingsNamespace::Telegram {
            self.telegram_sequence
                .lock()
                .expect("Telegram HTTP sequence lock")
                .push("settings".to_owned());
        }
        if namespace == SettingsNamespace::Weixin {
            self.weixin_sequence
                .lock()
                .expect("Weixin HTTP sequence lock")
                .push("settings".to_owned());
        }
        self.settings_changes
            .lock()
            .expect("settings changes lock")
            .push(namespace);
        Ok(())
    }

    async fn theme_changed(&self, _theme: ThemeMode) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn schedule_restart(&self, _delay_ms: u64) -> HttpRuntimeResult<()> {
        Ok(())
    }

    async fn tmux_health(&self) -> HttpRuntimeResult<TmuxHealth> {
        Ok(TmuxHealth {
            healthy: true,
            client_version: Some("tmux 3.5".to_owned()),
            client_provenance: None,
            server_version: Some("3.5".to_owned()),
            reason: "ok".to_owned(),
        })
    }

    async fn system_info(&self) -> HttpRuntimeResult<SystemInfo> {
        let can_self_update = self.can_self_update.load(Ordering::SeqCst);
        Ok(SystemInfo {
            version: "0.17.0_dev".to_owned(),
            base_version: "0.17.0".to_owned(),
            is_prod: can_self_update,
            installed_via_cli: can_self_update,
            deployment: if can_self_update {
                "launchd".to_owned()
            } else {
                "none".to_owned()
            },
            can_self_update,
            service_name: None,
            transfer_max_bytes: 2_147_483_648.0,
            management_mode: "none".to_owned(),
            update_owner: "self".to_owned(),
        })
    }
}

async fn test_handler() -> HttpHandler {
    test_handler_with_runtime().await.0
}

async fn test_handler_with_runtime() -> (HttpHandler, Arc<TestRuntime>) {
    let database = DatabaseBootstrap::new(DbConfig::in_memory())
        .run()
        .await
        .expect("bootstrap HTTP test database");
    let mut env = HashMap::new();
    env.insert("NODE_ENV".to_owned(), "test".to_owned());
    let config = GatewayConfig::from_env(
        GatewayEntryMode::Repository,
        GatewayPlatform::Posix,
        &env,
        None,
    )
    .expect("build HTTP test config");
    let runtime = Arc::new(TestRuntime::default());
    let handler = HttpHandler::with_master_key(
        Repository::new(database),
        config,
        MasterKey::development_default(),
        runtime.clone(),
        Arc::new(TestFileRuntime),
    );
    (handler, runtime)
}

async fn test_watch_handler() -> (HttpHandler, WatchService) {
    let handler = test_handler().await;
    handler
        .repository
        .create_device(devices::Model {
            id: "watch-http-device".to_owned(),
            name: "watch HTTP device".to_owned(),
            r#type: "local".to_owned(),
            host: None,
            port: Some(22),
            username: None,
            ssh_config_ref: None,
            session: Some("tmex".to_owned()),
            auth_mode: "auto".to_owned(),
            password_enc: None,
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: None,
            sort_order: 0,
            created_at: "2026-08-12T12:00:00.000Z".to_owned(),
            updated_at: "2026-08-12T12:00:00.000Z".to_owned(),
        })
        .await
        .expect("create watch HTTP test device");
    let service = WatchService::new(
        handler.repository.clone(),
        Arc::new(TestWatchRuntime),
        WatchServiceConfig::new(RepositorySiteSettingsDefaults {
            site_name: "tmex".to_owned(),
            site_url: "http://localhost:9883".to_owned(),
            bell_throttle_seconds: 5,
            notification_throttle_seconds: 5,
            ssh_reconnect_max_retries: 3,
            ssh_reconnect_delay_seconds: 2,
            language: "en_US".to_owned(),
        }),
    );
    service.start().await.expect("start watch HTTP service");
    (handler.with_watch_service(service.clone()), service)
}

fn request(method: Method, uri: &str, body: JsonValue) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(Bytes::from(
            serde_json::to_vec(&body).expect("serialize request body"),
        )))
        .expect("build request")
}

async fn response_body(response: super::HttpResponse) -> Bytes {
    to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("collect response body")
}

#[tokio::test]
async fn method_mismatch_accepts_a_legacy_sized_body_before_returning_json_404() {
    let body = JsonValue::String("x".repeat(256 * 1024));
    let response = test_handler()
        .await
        .handle(request(Method::POST, "/api/capabilities", body))
        .await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
    let body = response_body(response).await;
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&body).expect("decode response"),
        json!({ "error": "apiError.notFound" })
    );
}

#[tokio::test]
async fn device_responses_never_echo_plaintext_credentials() {
    const PASSWORD: &str = "plaintext-password";
    const PRIVATE_KEY: &str = "plaintext-private-key";
    const PASSPHRASE: &str = "plaintext-passphrase";

    let response = test_handler()
        .await
        .handle(request(
            Method::POST,
            "/api/devices",
            json!({
                "name": "remote",
                "type": "ssh",
                "host": "example.invalid",
                "authMode": "password",
                "password": PASSWORD,
                "privateKey": PRIVATE_KEY,
                "privateKeyPassphrase": PASSPHRASE,
            }),
        ))
        .await;

    assert_eq!(response.status(), StatusCode::CREATED);
    let response_body = response_body(response).await;
    let body_text = std::str::from_utf8(&response_body).expect("response is UTF-8 JSON");
    assert!(!body_text.contains(PASSWORD));
    assert!(!body_text.contains(PRIVATE_KEY));
    assert!(!body_text.contains(PASSPHRASE));

    let body = serde_json::from_slice::<JsonValue>(&response_body).expect("decode response");
    let device = body["device"].as_object().expect("device response");
    for (field, plaintext) in [
        ("passwordEnc", PASSWORD),
        ("privateKeyEnc", PRIVATE_KEY),
        ("privateKeyPassphraseEnc", PASSPHRASE),
    ] {
        let ciphertext = device[field].as_str().expect("ciphertext field");
        assert_ne!(ciphertext, plaintext);
        assert_eq!(
            MasterKey::development_default()
                .decrypt(ciphertext)
                .expect("decrypt response ciphertext"),
            plaintext
        );
    }
}

#[tokio::test]
async fn manifest_head_has_headers_and_no_body() {
    let response = test_handler()
        .await
        .handle(
            Request::builder()
                .method(Method::HEAD)
                .uri("/api/manifest.webmanifest")
                .body(Body::empty())
                .expect("build request"),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[CONTENT_TYPE],
        "application/manifest+json; charset=utf-8"
    );
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    assert!(response_body(response).await.is_empty());
}

#[tokio::test]
async fn watch_crud_refreshes_schedule_and_preserves_legacy_404s() {
    let (handler, service) = test_watch_handler().await;
    let response = handler
        .handle(request(
            Method::POST,
            "/api/watch/rules",
            json!({
                "name": "HTTP watch",
                "deviceId": "watch-http-device",
                "paneId": "%1",
                "triggerType": "match",
                "pattern": "ERROR",
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode created watch rule");
    let rule_id = created["rule"]["id"]
        .as_str()
        .expect("created watch rule id")
        .to_owned();
    assert_eq!(created["rule"]["intervalSeconds"], 30);
    assert_eq!(created["state"], JsonValue::Null);
    assert!(service.is_rule_scheduled(&rule_id));

    let response = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/watch/rules/{rule_id}"),
            json!({ "triggerType": "llm" }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/watch/rules/{rule_id}"),
            json!({ "enabled": false }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode updated watch rule");
    assert_eq!(updated["rule"]["triggerType"], "match");
    assert_eq!(updated["rule"]["enabled"], false);
    assert!(!service.is_rule_scheduled(&rule_id));

    let response = handler
        .handle(request(
            Method::PUT,
            &format!("/api/watch/rules/{rule_id}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(response).await)
            .expect("decode method mismatch response"),
        json!({ "error": "apiError.notFound" })
    );

    let response = handler
        .handle(request(
            Method::DELETE,
            &format!("/api/watch/rules/{rule_id}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(response).await)
            .expect("decode delete response"),
        json!({ "success": true })
    );

    let response = handler
        .handle(request(
            Method::GET,
            &format!("/api/watch/rules/{rule_id}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    service.stop().await;
}

#[tokio::test]
async fn watch_assist_regex_uses_injected_capture_and_returns_preview() {
    let (handler, service) = test_watch_handler().await;
    let response = handler
        .handle(request(
            Method::POST,
            "/api/watch/assist-regex",
            json!({
                "description": "download percentage",
                "deviceId": "watch-http-device",
                "paneId": "%1",
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(response).await)
            .expect("decode assist response"),
        json!({
            "pattern": "(\\d+)%",
            "flags": "",
            "extractGroup": 1,
            "explanation": "matches percentage",
            "preview": ["73%"],
        })
    );
    service.stop().await;
}

#[tokio::test]
async fn llm_provider_refresh_never_exposes_secrets_and_preserves_failure_statuses() {
    const API_KEY: &str = "sk-http-secret";
    const FAILED_API_KEY: &str = "sk-refresh-failure";

    let transport = Arc::new(TestModelsTransport::new([
        Ok(models_response(
            200,
            br#"{"data":[{"id":"z"},{"id":"shared"},{"id":"a"}]}"#,
        )),
        Ok(models_response(401, br#"{"error":"unauthorized"}"#)),
        Ok(models_response(500, br#"{"error":"down"}"#)),
    ]));
    let (handler, runtime) = test_handler_with_runtime().await;
    let handler = handler.with_models_transport(transport.clone());

    let response = handler
        .handle(request(
            Method::POST,
            "/api/llm/providers",
            json!({
                "name": "HTTP provider",
                "protocol": "openai-chat",
                "baseUrl": "https://models.example/v1",
                "apiKey": API_KEY,
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let raw = response_body(response).await;
    assert!(!String::from_utf8_lossy(&raw).contains(API_KEY));
    let created = serde_json::from_slice::<JsonValue>(&raw).expect("decode provider response");
    assert_eq!(created["provider"]["hasApiKey"], true);
    assert_eq!(created["provider"]["models"], json!(["a", "shared", "z"]));
    assert!(created["provider"].get("apiKeyEnc").is_none());
    let provider_id = created["provider"]["id"]
        .as_str()
        .expect("provider id")
        .to_owned();
    let stored = handler
        .repository
        .get_llm_provider_by_id(&provider_id)
        .await
        .expect("load provider")
        .expect("stored provider");
    assert_eq!(
        MasterKey::development_default()
            .decrypt(&stored.api_key_enc)
            .expect("decrypt provider key"),
        API_KEY
    );
    assert!(!String::from_utf8_lossy(&raw).contains(&stored.api_key_enc));

    let response = handler
        .handle(request(
            Method::POST,
            "/api/llm/providers",
            json!({
                "name": "Broken provider",
                "protocol": "openai-responses",
                "baseUrl": "https://broken.example/v1",
                "apiKey": FAILED_API_KEY,
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let raw = response_body(response).await;
    assert!(!String::from_utf8_lossy(&raw).contains(FAILED_API_KEY));
    let failed_create =
        serde_json::from_slice::<JsonValue>(&raw).expect("decode failed refresh create response");
    assert_eq!(failed_create["provider"]["models"], json!([]));
    assert!(failed_create["modelsError"]
        .as_str()
        .expect("models error")
        .contains("HTTP 401"));

    let response = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/llm/providers/{provider_id}"),
            json!({
                "apiKey": " ",
                "manualModels": ["shared", " ä ", "", "shared"],
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(transport.request_count(), 2);
    let patched = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode patched provider");
    assert_eq!(
        patched["provider"]["models"],
        json!(["a", "ä", "shared", "z"])
    );
    let shared = patched["provider"]["modelDetails"]
        .as_array()
        .expect("model details")
        .iter()
        .find(|model| model["id"] == "shared")
        .expect("shared model");
    assert_eq!(shared["source"], "fetched");
    let stored = handler
        .repository
        .get_llm_provider_by_id(&provider_id)
        .await
        .expect("load patched provider")
        .expect("patched provider exists");
    assert_eq!(
        MasterKey::development_default()
            .decrypt(&stored.api_key_enc)
            .expect("decrypt preserved provider key"),
        API_KEY
    );

    let response = handler
        .handle(request(
            Method::POST,
            &format!("/api/llm/providers/{provider_id}/refresh-models"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let failed_refresh = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode explicit refresh failure");
    assert!(failed_refresh["error"]
        .as_str()
        .expect("refresh error")
        .contains("HTTP 500"));
    assert_eq!(transport.request_count(), 3);
    assert_eq!(
        *runtime
            .settings_changes
            .lock()
            .expect("settings changes lock"),
        [
            SettingsNamespace::Llm,
            SettingsNamespace::Llm,
            SettingsNamespace::Llm,
        ]
    );
}

#[tokio::test]
async fn llm_search_keys_keep_omitted_values_and_clear_on_empty_strings() {
    const TAVILY_KEY: &str = "tvly-http-secret";

    let (handler, runtime) = test_handler_with_runtime().await;
    let response = handler
        .handle(request(
            Method::PATCH,
            "/api/llm/settings",
            json!({
                "searchProvider": "tavily",
                "tavilyApiKey": format!("  {TAVILY_KEY}  "),
            }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let raw = response_body(response).await;
    assert!(!String::from_utf8_lossy(&raw).contains(TAVILY_KEY));
    let settings = serde_json::from_slice::<JsonValue>(&raw).expect("decode LLM settings");
    assert_eq!(settings["settings"]["hasTavilyApiKey"], true);
    assert!(settings["settings"].get("tavilyApiKeyEnc").is_none());
    let stored = handler
        .repository
        .get_agent_settings()
        .await
        .expect("load agent settings");
    let ciphertext = stored
        .tavily_api_key_enc
        .as_deref()
        .expect("stored Tavily ciphertext");
    assert_eq!(
        MasterKey::development_default()
            .decrypt(ciphertext)
            .expect("decrypt Tavily key"),
        TAVILY_KEY
    );
    assert!(!String::from_utf8_lossy(&raw).contains(ciphertext));

    let response = handler
        .handle(request(
            Method::PATCH,
            "/api/llm/settings",
            json!({ "searchProvider": "brave" }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let kept = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode kept LLM settings");
    assert_eq!(kept["settings"]["hasTavilyApiKey"], true);

    let response = handler
        .handle(request(Method::GET, "/api/llm/settings", JsonValue::Null))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let listed = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode listed LLM settings");
    assert_eq!(
        listed["searchProviders"],
        json!([
            { "id": "tavily", "label": "Tavily", "isConfigured": true },
            { "id": "brave", "label": "Brave", "isConfigured": false },
        ])
    );

    let response = handler
        .handle(request(
            Method::PATCH,
            "/api/llm/settings",
            json!({ "tavilyApiKey": "" }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cleared = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode cleared LLM settings");
    assert_eq!(cleared["settings"]["hasTavilyApiKey"], false);
    assert!(handler
        .repository
        .get_agent_settings()
        .await
        .expect("load cleared settings")
        .tavily_api_key_enc
        .is_none());
    assert_eq!(
        *runtime
            .settings_changes
            .lock()
            .expect("settings changes lock"),
        [
            SettingsNamespace::Llm,
            SettingsNamespace::Llm,
            SettingsNamespace::Llm,
        ]
    );

    let response = handler
        .handle(request(Method::PUT, "/api/llm/settings", JsonValue::Null))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

async fn create_agent_test_device(handler: &HttpHandler, id: &str, password_enc: Option<&str>) {
    handler
        .repository
        .create_device(devices::Model {
            id: id.to_owned(),
            name: "agent HTTP device".to_owned(),
            r#type: "local".to_owned(),
            host: None,
            port: Some(22),
            username: None,
            ssh_config_ref: None,
            session: Some("tmex-http-test".to_owned()),
            auth_mode: "auto".to_owned(),
            password_enc: password_enc.map(str::to_owned),
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: None,
            sort_order: 0,
            created_at: "2026-08-12T12:00:00.000Z".to_owned(),
            updated_at: "2026-08-12T12:00:00.000Z".to_owned(),
        })
        .await
        .expect("create agent HTTP device");
}

async fn create_agent_test_session(
    handler: &HttpHandler,
    device_id: &str,
) -> crate::entity::agent_sessions::Model {
    handler
        .repository
        .create_agent_session(CreateAgentSessionInput {
            title: "Agent HTTP session".to_owned(),
            device_id: Some(device_id.to_owned()),
            pane_id: Some("%42".to_owned()),
            provider_id: None,
            model_id: "test-model".to_owned(),
            system_prompt: None,
            write_mode: None,
            use_provider_web_search: None,
            provider_hosted_tools: None,
            allow_control_chars: None,
            origin_pane_title: None,
            origin_process_name: None,
            max_steps_per_turn: None,
        })
        .await
        .expect("create agent HTTP session")
}

#[tokio::test]
async fn agent_session_creation_enforces_provider_protocol_and_omits_stored_secrets() {
    const DEVICE_SECRET: &str = "device-ciphertext-must-not-leak";
    const PROVIDER_SECRET: &str = "provider-ciphertext-must-not-leak";

    let handler = test_handler().await;
    create_agent_test_device(&handler, "agent-http-create-device", Some(DEVICE_SECRET)).await;
    let chat_provider = handler
        .repository
        .create_llm_provider(CreateLlmProviderInput {
            name: "chat provider".to_owned(),
            protocol: "openai-chat".to_owned(),
            base_url: "https://chat.example/v1".to_owned(),
            api_key_enc: PROVIDER_SECRET.to_owned(),
            enabled: Some(true),
        })
        .await
        .expect("create chat provider");
    let responses_provider = handler
        .repository
        .create_llm_provider(CreateLlmProviderInput {
            name: "responses provider".to_owned(),
            protocol: "openai-responses".to_owned(),
            base_url: "https://responses.example/v1".to_owned(),
            api_key_enc: PROVIDER_SECRET.to_owned(),
            enabled: Some(true),
        })
        .await
        .expect("create responses provider");
    handler
        .repository
        .update_agent_settings(AgentSettingsUpdate {
            default_provider_id: Some(Some(responses_provider.id.clone())),
            default_model_id: Some(Some("default-model".to_owned())),
            ..AgentSettingsUpdate::default()
        })
        .await
        .expect("set agent defaults");

    let rejected = handler
        .handle(request(
            Method::POST,
            "/api/agent/sessions",
            json!({
                "deviceId": "agent-http-create-device",
                "paneId": "%1",
                "providerId": chat_provider.id,
                "modelId": "chat-model",
                "useProviderWebSearch": true,
            }),
        ))
        .await;
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);

    let created = handler
        .handle(request(
            Method::POST,
            "/api/agent/sessions",
            json!({
                "deviceId": "agent-http-create-device",
                "paneId": "  %7  ",
                "useProviderWebSearch": true,
                "providerHostedTools": ["image_generation", "image_generation"],
                "originPaneTitle": "  build pane  ",
                "maxStepsPerTurn": 2.9,
            }),
        ))
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let raw = response_body(created).await;
    let raw_text = String::from_utf8_lossy(&raw);
    assert!(!raw_text.contains(DEVICE_SECRET));
    assert!(!raw_text.contains(PROVIDER_SECRET));
    let payload = serde_json::from_slice::<JsonValue>(&raw).expect("decode created agent session");
    assert_eq!(payload["session"]["title"], "New Session");
    assert_eq!(payload["session"]["paneId"], "%7");
    assert_eq!(payload["session"]["providerId"], JsonValue::Null);
    assert_eq!(payload["session"]["modelId"], "default-model");
    assert_eq!(payload["session"]["writeMode"], "confirm");
    assert_eq!(payload["session"]["useProviderWebSearch"], true);
    assert_eq!(
        payload["session"]["providerHostedTools"],
        json!(["image_generation"])
    );
    assert_eq!(payload["session"]["originPaneTitle"], "build pane");
    assert_eq!(payload["session"]["originProcessName"], "test-shell");
    assert_eq!(payload["session"]["maxStepsPerTurn"], 2);

    let session_id = payload["session"]["id"]
        .as_str()
        .expect("created session id");
    let incompatible_patch = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/agent/sessions/{session_id}"),
            json!({ "providerId": chat_provider.id }),
        ))
        .await;
    assert_eq!(incompatible_patch.status(), StatusCode::BAD_REQUEST);

    let method_mismatch = handler
        .handle(request(Method::PUT, "/api/agent/sessions", JsonValue::Null))
        .await;
    assert_eq!(method_mismatch.status(), StatusCode::NOT_FOUND);
    let trailing_slash = handler
        .handle(request(
            Method::GET,
            "/api/agent/sessions/",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(trailing_slash.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn agent_delete_waits_for_stop_and_supervisor_errors_keep_http_statuses_redacted() {
    const ERROR_SECRET: &str = "sk-abcdefghijklmnop";

    let handler = test_handler().await;
    create_agent_test_device(&handler, "agent-http-service-device", None).await;
    let session = create_agent_test_session(&handler, "agent-http-service-device").await;
    let service = Arc::new(TestAgentService::new(handler.repository.clone()));
    service.mark_active(&session.id);
    let handler = handler.with_agent_service(service.clone());

    let deleted = handler
        .handle(request(
            Method::DELETE,
            &format!("/api/agent/sessions/{}", session.id),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert!(*service
        .saw_session_during_stop
        .lock()
        .expect("stop ordering lock"));
    {
        let stopped = service.stopped.lock().expect("stopped sessions lock");
        assert_eq!(stopped.as_slice(), std::slice::from_ref(&session.id));
    }
    assert!(handler
        .repository
        .get_agent_session_by_id(&session.id)
        .await
        .expect("query deleted session")
        .is_none());

    let session = create_agent_test_session(&handler, "agent-http-service-device").await;
    service.push_submit_error(AgentError::SessionBusy);
    let conflict = handler
        .handle(request(
            Method::POST,
            &format!("/api/agent/sessions/{}/messages", session.id),
            json!({ "text": "hello" }),
        ))
        .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    service.push_submit_error(
        AgentPortError::new(format!("upstream rejected bearer {ERROR_SECRET}")).into(),
    );
    let internal = handler
        .handle(request(
            Method::POST,
            &format!("/api/agent/sessions/{}/messages", session.id),
            json!({ "text": "hello again" }),
        ))
        .await;
    assert_eq!(internal.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!String::from_utf8_lossy(&response_body(internal).await).contains(ERROR_SECRET));

    service.push_confirmation_error(AgentError::ConfirmationNotFound);
    let missing = handler
        .handle(request(
            Method::POST,
            "/api/agent/confirmations/missing/decide",
            json!({ "approved": true }),
        ))
        .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    service.push_confirmation_error(AgentError::ConfirmationAlreadyDecided);
    let decided = handler
        .handle(request(
            Method::POST,
            "/api/agent/confirmations/decided/decide",
            json!({ "approved": false }),
        ))
        .await;
    assert_eq!(decided.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn agent_json_dtos_preserve_values_and_after_seq_uses_javascript_integer_rules() {
    let handler = test_handler().await;
    create_agent_test_device(&handler, "agent-http-json-device", None).await;
    let session = create_agent_test_session(&handler, "agent-http-json-device").await;
    handler
        .repository
        .append_agent_message(
            &session.id,
            "user",
            json!({ "role": "user", "content": { "nested": [1, true, null] } }),
        )
        .await
        .expect("append first agent message");
    handler
        .repository
        .append_agent_message(
            &session.id,
            "assistant",
            json!({ "role": "assistant", "content": ["second", { "count": 2 }] }),
        )
        .await
        .expect("append second agent message");

    let response = handler
        .handle(request(
            Method::GET,
            &format!("/api/agent/sessions/{}/messages?afterSeq=0e0", session.id),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let messages = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode agent messages");
    assert_eq!(messages["messages"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        messages["messages"][0]["content"],
        json!({ "role": "assistant", "content": ["second", { "count": 2 }] })
    );

    let empty_after_seq = handler
        .handle(request(
            Method::GET,
            &format!("/api/agent/sessions/{}/messages?afterSeq=", session.id),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(empty_after_seq.status(), StatusCode::OK);
    let invalid_after_seq = handler
        .handle(request(
            Method::GET,
            &format!("/api/agent/sessions/{}/messages?afterSeq=1.5", session.id),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(invalid_after_seq.status(), StatusCode::BAD_REQUEST);

    let confirmation = handler
        .repository
        .create_agent_confirmation(CreateAgentConfirmationInput {
            id: None,
            session_id: session.id.clone(),
            tool_name: "send_input".to_owned(),
            tool_call_id: "call-json".to_owned(),
            input_json: json!({ "text": "pwd", "options": { "literal": true } }),
        })
        .await
        .expect("create agent confirmation");
    let response = handler
        .handle(request(
            Method::GET,
            &format!("/api/agent/sessions/{}/confirmations", session.id),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let confirmations = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode agent confirmations");
    assert_eq!(confirmations["confirmations"][0]["id"], confirmation.id);
    assert_eq!(
        confirmations["confirmations"][0]["input"],
        json!({ "text": "pwd", "options": { "literal": true } })
    );
}

#[tokio::test]
async fn telegram_bot_writes_keep_tokens_secret_and_broadcast_before_refresh() {
    const TOKEN: &str = "123456:telegram-http-secret";

    let (base_handler, runtime) = test_handler_with_runtime().await;
    let unavailable = base_handler
        .handle(request(
            Method::POST,
            "/api/settings/telegram/bots",
            json!({ "name": "bot", "token": TOKEN }),
        ))
        .await;
    assert_eq!(unavailable.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!String::from_utf8_lossy(&response_body(unavailable).await).contains(TOKEN));
    assert!(base_handler
        .repository
        .get_all_telegram_bots()
        .await
        .expect("list bots after unavailable service")
        .is_empty());

    let service = Arc::new(TestTelegramService::new(runtime));
    let handler = base_handler.with_telegram_service(service.clone());
    let created = handler
        .handle(request(
            Method::POST,
            "/api/settings/telegram/bots",
            json!({
                "name": "  notification bot  ",
                "token": format!("  {TOKEN}  "),
                "enabled": false,
                "allowAuthRequests": false,
            }),
        ))
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_body = response_body(created).await;
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&created_body).expect("decode create bot response"),
        json!({ "success": true })
    );
    assert!(!String::from_utf8_lossy(&created_body).contains(TOKEN));
    assert_eq!(service.sequence(), ["settings", "refresh"]);

    let bot = handler
        .repository
        .get_all_telegram_bots()
        .await
        .expect("list created Telegram bot")
        .pop()
        .expect("created Telegram bot");
    assert_eq!(bot.name, "notification bot");
    assert_eq!(bot.enabled, 0);
    assert_eq!(bot.allow_auth_requests, 0);
    assert_ne!(bot.token_enc, TOKEN);
    assert_eq!(
        handler
            .master_key
            .decrypt_with_context(
                &bot.token_enc,
                CryptoContext::new("telegram_bot")
                    .entity_id(&bot.id)
                    .field("token_enc"),
            )
            .expect("decrypt Telegram bot token with service context"),
        TOKEN
    );

    let listed = handler
        .handle(request(
            Method::GET,
            "/api/settings/telegram/bots",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_body = response_body(listed).await;
    let listed_text = String::from_utf8_lossy(&listed_body);
    assert!(!listed_text.contains(TOKEN));
    assert!(!listed_text.contains("tokenEnc"));
    let listed_json = serde_json::from_slice::<JsonValue>(&listed_body).expect("decode bot list");
    assert_eq!(listed_json["bots"][0]["pendingCount"], 0);
    assert_eq!(listed_json["bots"][0]["authorizedCount"], 0);

    let original_ciphertext = bot.token_enc;
    service.clear_sequence();
    let updated = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/settings/telegram/bots/{}", bot.id),
            json!({ "name": "  renamed bot  " }),
        ))
        .await;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(service.sequence(), ["settings", "refresh"]);
    let updated_bot = handler
        .repository
        .get_telegram_bot_by_id(&bot.id)
        .await
        .expect("query updated Telegram bot")
        .expect("updated Telegram bot");
    assert_eq!(updated_bot.name, "renamed bot");
    assert_eq!(updated_bot.token_enc, original_ciphertext);

    service.clear_sequence();
    let empty_token = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/settings/telegram/bots/{}", bot.id),
            json!({ "token": "   " }),
        ))
        .await;
    assert_eq!(empty_token.status(), StatusCode::BAD_REQUEST);
    assert!(service.sequence().is_empty());

    service.fail_refresh.store(true, Ordering::SeqCst);
    service.clear_sequence();
    let refresh_failed = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/settings/telegram/bots/{}", bot.id),
            json!({ "enabled": true }),
        ))
        .await;
    assert_eq!(refresh_failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!String::from_utf8_lossy(&response_body(refresh_failed).await).contains(TOKEN));
    assert_eq!(service.sequence(), ["settings", "refresh"]);
    assert_eq!(
        handler
            .repository
            .get_telegram_bot_by_id(&bot.id)
            .await
            .expect("query Telegram bot after refresh failure")
            .expect("Telegram bot after refresh failure")
            .enabled,
        1
    );

    let method_mismatch = handler
        .handle(request(
            Method::PUT,
            "/api/settings/telegram/bots",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(method_mismatch.status(), StatusCode::NOT_FOUND);
    let trailing_slash = handler
        .handle(request(
            Method::GET,
            "/api/settings/telegram/bots/",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(trailing_slash.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn telegram_chat_approval_decodes_ids_and_keeps_write_broadcast_send_order_on_failure() {
    const TOKEN: &str = "987654:telegram-chat-secret";
    const BOT_ID: &str = "telegram-http-bot";
    const CHAT_ID: &str = "-100/channel?thread=1";
    const ENCODED_CHAT_ID: &str = "-100%2Fchannel%3Fthread%3D1";
    const NOW: &str = "2026-08-12T12:00:00.000Z";

    let (handler, runtime) = test_handler_with_runtime().await;
    let service = Arc::new(TestTelegramService::new(runtime));
    let handler = handler.with_telegram_service(service.clone());
    handler
        .repository
        .create_telegram_bot(telegram_bots::Model {
            id: BOT_ID.to_owned(),
            name: "alerts bot".to_owned(),
            token_enc: handler
                .master_key
                .encrypt(TOKEN)
                .expect("encrypt bot token"),
            enabled: 1,
            allow_auth_requests: 1,
            last_update_id: None,
            created_at: NOW.to_owned(),
            updated_at: NOW.to_owned(),
        })
        .await
        .expect("seed Telegram bot");
    handler
        .repository
        .create_or_update_pending_telegram_chat(CreatePendingTelegramChatInput {
            bot_id: BOT_ID.to_owned(),
            chat_id: CHAT_ID.to_owned(),
            chat_type: "supergroup".to_owned(),
            display_name: "release room".to_owned(),
            applied_at: NOW.to_owned(),
        })
        .await
        .expect("seed pending Telegram chat");

    service.fail_send.store(true, Ordering::SeqCst);
    let approved = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/telegram/bots/{BOT_ID}/chats/{ENCODED_CHAT_ID}/approve"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(approved.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!String::from_utf8_lossy(&response_body(approved).await).contains(TOKEN));
    assert_eq!(service.sequence(), ["settings", &format!("send:{CHAT_ID}")]);
    let authorized = handler
        .repository
        .get_telegram_chat_by_bot_and_chat_id(BOT_ID, CHAT_ID)
        .await
        .expect("query approved Telegram chat")
        .expect("approved Telegram chat");
    assert_eq!(authorized.status, "authorized");
    assert!(authorized.authorized_at.is_some());
    {
        let messages = service
            .sent_messages
            .lock()
            .expect("Telegram test messages lock");
        assert_eq!(messages[0].0, BOT_ID);
        assert_eq!(messages[0].1, CHAT_ID);
        assert!(messages[0].2.contains("alerts bot"));
        assert!(!messages[0].2.contains("{{"));
    }

    service.clear_sequence();
    let tested = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/telegram/bots/{BOT_ID}/chats/{ENCODED_CHAT_ID}/test"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(tested.status(), StatusCode::OK);
    assert_eq!(service.sequence(), [format!("send:{CHAT_ID}")]);
    {
        let messages = service
            .sent_messages
            .lock()
            .expect("Telegram test messages lock");
        let (_, chat_id, message) = messages.last().expect("Telegram test message");
        assert_eq!(chat_id, CHAT_ID);
        assert!(message.starts_with("Test message for "));
        assert!(!message.contains("{{"));
    }

    let malformed_chat_id = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/telegram/bots/{BOT_ID}/chats/%ZZ/test"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(malformed_chat_id.status(), StatusCode::BAD_REQUEST);

    service.clear_sequence();
    let deleted = handler
        .handle(request(
            Method::DELETE,
            &format!("/api/settings/telegram/bots/{BOT_ID}/chats/{ENCODED_CHAT_ID}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(service.sequence(), ["settings"]);
    assert!(handler
        .repository
        .get_telegram_chat_by_bot_and_chat_id(BOT_ID, CHAT_ID)
        .await
        .expect("query deleted Telegram chat")
        .is_none());
}

#[tokio::test]
async fn weixin_account_routes_keep_credentials_secret_and_write_before_broadcast_and_refresh() {
    const TOKEN: &str = "weixin-http-token-secret";
    const BASE_URL: &str = "https://weixin-http-secret.example";
    const SYNC_BUF: &str = "weixin-http-sync-secret";

    let (base_handler, runtime) = test_handler_with_runtime().await;
    let service = Arc::new(TestWeixinService::new(runtime));
    let handler = base_handler.with_weixin_service(service.clone());

    let empty_name = handler
        .handle(request(
            Method::POST,
            "/api/settings/weixin/accounts",
            json!({ "name": "   " }),
        ))
        .await;
    assert_eq!(empty_name.status(), StatusCode::BAD_REQUEST);

    let created = handler
        .handle(request(
            Method::POST,
            "/api/settings/weixin/accounts",
            json!({ "name": "  release account  " }),
        ))
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = serde_json::from_slice::<JsonValue>(&response_body(created).await)
        .expect("decode Weixin create response");
    assert_eq!(created["success"], true);
    let account_id = created["accountId"]
        .as_str()
        .expect("created Weixin account id");
    assert_eq!(service.sequence(), ["settings"]);

    let account = handler
        .repository
        .get_weixin_account_by_id(account_id)
        .await
        .expect("query Weixin account")
        .expect("created Weixin account");
    assert_eq!(account.name, "release account");
    assert_eq!(account.enabled, 1);
    assert_eq!(account.allow_auth_requests, 1);
    handler
        .repository
        .update_weixin_account(
            account_id,
            WeixinAccountUpdate {
                bot_token_enc: Some(Some(TOKEN.to_owned())),
                base_url: Some(Some(BASE_URL.to_owned())),
                sync_buf: Some(Some(SYNC_BUF.to_owned())),
                ..WeixinAccountUpdate::default()
            },
        )
        .await
        .expect("seed Weixin secrets");

    let listed = handler
        .handle(request(
            Method::GET,
            "/api/settings/weixin/accounts",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_body = response_body(listed).await;
    let listed_text = String::from_utf8_lossy(&listed_body);
    for secret in [TOKEN, BASE_URL, SYNC_BUF] {
        assert!(!listed_text.contains(secret));
    }
    for private_field in ["botTokenEnc", "baseUrl", "syncBuf", "weixinUin"] {
        assert!(!listed_text.contains(private_field));
    }
    let listed = serde_json::from_slice::<JsonValue>(&listed_body).expect("decode Weixin list");
    assert_eq!(listed["accounts"][0]["loggedIn"], true);
    assert_eq!(listed["accounts"][0]["authorizedCount"], 0);

    service.clear_sequence();
    let patched = handler
        .handle(request(
            Method::PATCH,
            &format!("/api/settings/weixin/accounts/{account_id}"),
            json!({ "name": "  renamed account  ", "allowAuthRequests": false }),
        ))
        .await;
    assert_eq!(patched.status(), StatusCode::OK);
    assert_eq!(service.sequence(), ["settings", "refresh"]);
    let patched = handler
        .repository
        .get_weixin_account_by_id(account_id)
        .await
        .expect("query patched Weixin account")
        .expect("patched Weixin account");
    assert_eq!(patched.name, "renamed account");
    assert_eq!(patched.allow_auth_requests, 0);

    let method_mismatch = handler
        .handle(request(
            Method::PUT,
            "/api/settings/weixin/accounts",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(method_mismatch.status(), StatusCode::NOT_FOUND);
    let trailing_slash = handler
        .handle(request(
            Method::GET,
            "/api/settings/weixin/accounts/",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(trailing_slash.status(), StatusCode::NOT_FOUND);

    service.clear_sequence();
    let deleted = handler
        .handle(request(
            Method::DELETE,
            &format!("/api/settings/weixin/accounts/{account_id}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(service.sequence(), ["settings", "refresh"]);
    assert!(handler
        .repository
        .get_weixin_account_by_id(account_id)
        .await
        .expect("query deleted Weixin account")
        .is_none());
}

#[tokio::test]
async fn weixin_login_and_user_routes_preserve_statuses_decoding_and_best_effort_ack() {
    const ACCOUNT_ID: &str = "weixin-http-account";
    const USER_ID: &str = "alice/channel?thread=1";
    const ENCODED_USER_ID: &str = "alice%2Fchannel%3Fthread%3D1";
    const CONTEXT_TOKEN: &str = "weixin-context-secret";
    const NOW: &str = "2026-08-12T12:00:00.000Z";

    let (base_handler, runtime) = test_handler_with_runtime().await;
    let service = Arc::new(TestWeixinService::new(runtime));
    let handler = base_handler.with_weixin_service(service.clone());
    handler
        .repository
        .create_weixin_account(weixin_accounts::Model {
            id: ACCOUNT_ID.to_owned(),
            name: "alerts account".to_owned(),
            enabled: 1,
            allow_auth_requests: 1,
            weixin_uin: Some("weixin-uin-secret".to_owned()),
            bot_token_enc: Some("weixin-ciphertext-secret".to_owned()),
            base_url: Some("https://weixin-user-secret.example".to_owned()),
            sync_buf: Some("weixin-sync-secret".to_owned()),
            created_at: NOW.to_owned(),
            updated_at: NOW.to_owned(),
        })
        .await
        .expect("seed Weixin account");
    handler
        .repository
        .upsert_weixin_user_on_inbound(UpsertWeixinUserInput {
            account_id: ACCOUNT_ID.to_owned(),
            user_id: USER_ID.to_owned(),
            display_name: "Alice".to_owned(),
            context_token: Some(CONTEXT_TOKEN.to_owned()),
            allow_auth_requests: true,
            at: NOW.to_owned(),
        })
        .await
        .expect("seed pending Weixin user");

    let login = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/login/start"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(login.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(login).await)
            .expect("decode login start"),
        json!({ "qrcodeUrl": "weixin-qr-url", "qrcodeId": "weixin-qr-id" })
    );
    let status = handler
        .handle(request(
            Method::GET,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/login/status"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(status.status(), StatusCode::OK);

    let users = handler
        .handle(request(
            Method::GET,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/users"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(users.status(), StatusCode::OK);
    let users_body = response_body(users).await;
    let users_text = String::from_utf8_lossy(&users_body);
    assert!(!users_text.contains(CONTEXT_TOKEN));
    assert!(!users_text.contains("lastContextToken"));

    service.fail_send.store(true, Ordering::SeqCst);
    service.clear_sequence();
    let approved = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/users/{ENCODED_USER_ID}/approve"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(approved.status(), StatusCode::OK);
    let approved_body = response_body(approved).await;
    assert!(!String::from_utf8_lossy(&approved_body).contains(CONTEXT_TOKEN));
    assert_eq!(service.sequence(), ["settings", &format!("send:{USER_ID}")]);
    assert_eq!(
        handler
            .repository
            .get_weixin_user_by_account_and_user_id(ACCOUNT_ID, USER_ID)
            .await
            .expect("query approved Weixin user")
            .expect("approved Weixin user")
            .status,
        "authorized"
    );

    service.fail_send.store(true, Ordering::SeqCst);
    let user_test = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/users/{ENCODED_USER_ID}/test"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(user_test.status(), StatusCode::BAD_REQUEST);
    service.fail_send.store(true, Ordering::SeqCst);
    let account_test = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/test"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(account_test.status(), StatusCode::BAD_REQUEST);

    service.fail_start.store(true, Ordering::SeqCst);
    let failed_login = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/login/start"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(failed_login.status(), StatusCode::BAD_GATEWAY);
    let missing_status = handler
        .handle(request(
            Method::GET,
            "/api/settings/weixin/accounts/missing/login/status",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(missing_status.status(), StatusCode::NOT_FOUND);
    let malformed_user = handler
        .handle(request(
            Method::POST,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/users/%ZZ/test"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(malformed_user.status(), StatusCode::NOT_FOUND);

    service.clear_sequence();
    let deleted = handler
        .handle(request(
            Method::DELETE,
            &format!("/api/settings/weixin/accounts/{ACCOUNT_ID}/users/{ENCODED_USER_ID}"),
            JsonValue::Null,
        ))
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(service.sequence(), ["settings"]);
    assert!(handler
        .repository
        .get_weixin_user_by_account_and_user_id(ACCOUNT_ID, USER_ID)
        .await
        .expect("query deleted Weixin user")
        .is_none());
}

struct FixedUpdateRegistry {
    packument: RegistryPackument,
    changelog: Option<String>,
}

#[async_trait]
impl UpdateRegistry for FixedUpdateRegistry {
    async fn fetch_packument(&self) -> Result<RegistryPackument, UpdateRegistryError> {
        Ok(self.packument.clone())
    }

    async fn fetch_changelog(&self, _version: &str) -> Option<String> {
        self.changelog.clone()
    }
}

struct RecordingUpgradeRunner {
    versions: Mutex<Vec<String>>,
}

#[async_trait]
impl UpgradeRunner for RecordingUpgradeRunner {
    async fn download_and_execute(&self, version: &str) -> Result<(), UpgradeRunError> {
        self.versions
            .lock()
            .expect("upgrade versions")
            .push(version.to_owned());
        Ok(())
    }
}

#[tokio::test]
async fn standalone_update_check_uses_registry_payload_and_semver() {
    let (handler, _) = test_handler_with_runtime().await;
    let handler = handler.with_update_registry(Arc::new(FixedUpdateRegistry {
        packument: RegistryPackument {
            latest: Some("0.18.0".to_owned()),
            published_at: Some("2026-08-13T00:00:00.000Z".to_owned()),
        },
        changelog: Some("# 0.18.0\n".to_owned()),
    }));
    let response = handler
        .handle(request(
            Method::GET,
            "/api/system/update-check",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = serde_json::from_slice::<JsonValue>(&response_body(response).await)
        .expect("decode update-check");
    assert_eq!(body["currentVersion"], "0.17.0");
    assert_eq!(body["latestVersion"], "0.18.0");
    assert_eq!(body["hasUpdate"], true);
    assert_eq!(body["changelog"], "# 0.18.0\n");
    assert_eq!(body["publishedAt"], "2026-08-13T00:00:00.000Z");
}

#[tokio::test]
async fn standalone_update_routes_reject_method_mismatch_with_json_404() {
    let handler = test_handler().await;
    let response = handler
        .handle(request(
            Method::PUT,
            "/api/system/update-check",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let upgrade = handler
        .handle(request(
            Method::DELETE,
            "/api/system/upgrade",
            JsonValue::Null,
        ))
        .await;
    assert_eq!(upgrade.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn managed_update_routes_return_managed_externally_for_any_method() {
    let database = DatabaseBootstrap::new(DbConfig::in_memory())
        .run()
        .await
        .expect("bootstrap managed HTTP test database");
    let mut env = HashMap::new();
    env.insert("NODE_ENV".to_owned(), "production".to_owned());
    env.insert(
        "TMEX_MASTER_KEY".to_owned(),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
    );
    let config = GatewayConfig::from_env(
        GatewayEntryMode::Embedded,
        GatewayPlatform::Posix,
        &env,
        None,
    )
    .expect("build embedded HTTP test config");
    let handler = HttpHandler::with_master_key(
        Repository::new(database),
        config,
        MasterKey::development_default(),
        Arc::new(TestRuntime::default()),
        Arc::new(TestFileRuntime),
    );
    for (method, path) in [
        (Method::GET, "/api/system/update-check"),
        (Method::POST, "/api/system/upgrade"),
        (Method::PUT, "/api/system/upgrade"),
    ] {
        let response = handler.handle(request(method, path, JsonValue::Null)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&response_body(response).await)
                .expect("decode managed response"),
            json!({
                "error": "managed_externally",
                "managed": true,
                "canSelfUpdate": false,
            })
        );
    }
}

#[tokio::test]
async fn standalone_upgrade_enforces_can_self_update_version_and_busy_state() {
    let (handler, runtime) = test_handler_with_runtime().await;
    let runner = Arc::new(RecordingUpgradeRunner {
        versions: Mutex::new(Vec::new()),
    });
    let handler = handler.with_upgrade_controller(UpgradeController::new(runner.clone()));

    let idle = handler
        .handle(request(Method::GET, "/api/system/upgrade", JsonValue::Null))
        .await;
    assert_eq!(idle.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(idle).await).expect("decode idle"),
        json!({
            "state": "idle",
            "targetVersion": null,
            "error": null,
            "startedAt": null,
        })
    );

    let denied = handler
        .handle(request(
            Method::POST,
            "/api/system/upgrade",
            json!({ "version": "0.18.0" }),
        ))
        .await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(denied).await).expect("decode denied"),
        json!({ "error": "apiError.upgradeNotAllowed" })
    );

    runtime.can_self_update.store(true, Ordering::SeqCst);
    let missing = handler
        .handle(request(Method::POST, "/api/system/upgrade", json!({})))
        .await;
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<JsonValue>(&response_body(missing).await)
            .expect("decode missing version"),
        json!({ "error": "apiError.upgradeVersionRequired" })
    );

    let started = handler
        .handle(request(
            Method::POST,
            "/api/system/upgrade",
            json!({ "version": "0.18.0" }),
        ))
        .await;
    assert_eq!(started.status(), StatusCode::OK);
    let started_body = serde_json::from_slice::<JsonValue>(&response_body(started).await)
        .expect("decode started upgrade");
    assert_eq!(started_body["state"], "downloading");
    assert_eq!(started_body["targetVersion"], "0.18.0");

    let busy = handler
        .handle(request(
            Method::POST,
            "/api/system/upgrade",
            json!({ "version": "0.19.0" }),
        ))
        .await;
    assert_eq!(busy.status(), StatusCode::CONFLICT);
    let busy_body =
        serde_json::from_slice::<JsonValue>(&response_body(busy).await).expect("decode busy");
    assert_eq!(busy_body["error"], "apiError.upgradeInProgress");
    assert_ne!(busy_body["state"], "idle");
    assert_eq!(busy_body["targetVersion"], "0.18.0");

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if runner.versions.lock().expect("upgrade versions").as_slice() == ["0.18.0"] {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("upgrade runner received the accepted version");
}
