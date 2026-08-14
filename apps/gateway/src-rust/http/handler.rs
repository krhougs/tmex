use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use bytes::Bytes;
use http::{Method, Request, StatusCode, Uri};
use percent_encoding::percent_decode_str;
use sea_orm::entity::prelude::{ChronoDateTimeUtc, Json};
use serde::Serialize;
use serde_json::{json as json_value, Map as JsonMap, Value as JsonValue};
use uuid::Uuid;

use crate::config::{
    GatewayConfig, GatewayEntryMode, ManagementMode, UpdateOwner, GATEWAY_VERSION,
};
use crate::crypto::{CryptoError, MasterKey};
use crate::database::repository::{
    Repository, RepositorySiteSettingsDefaults, SiteSettingsUpdate, TerminalShortcutSettingsRecord,
    UpdateDevice,
};
use crate::entity::{devices, webhook_endpoints};
use crate::files::{FileRuntime, FileService};
use crate::llm::{ModelsHttpTransport, ReqwestModelsHttpTransport};
use crate::system::update_check::{check_for_update, ReqwestUpdateRegistry, UpdateRegistry};
use crate::system::upgrade::UpgradeController;
use crate::tmux::is_tmux_pane_id;
use crate::watch::WatchService;
use crate::ws::DEFAULT_CAPABILITIES;

use super::agent::AgentHttpService;
use super::dto::{
    DeviceResponse, DeviceWithRuntimeResponse, SettingsNamespace, SiteSettingsResponse,
    StateSnapshot, SystemInfo, TerminalShortcutSettingsResponse, ThemeMode, TmuxHealth,
    TreeCustomNames, TreeOrderChange,
};
use super::owner_proof::{create_gateway_owner_proof, GatewayOwnerProof};
use super::response::{error_json, json, manifest, HandlerError, HandlerResult, HttpResponse};
use super::runtime::HttpRuntime;
use super::telegram::TelegramHttpService;
use super::weixin::WeixinHttpService;

const API_VERSION: u8 = 1;
const CORE_BODY_LIMIT: usize = 128 * 1024 * 1024;
const RESTART_DELAY_MS: u64 = 50;
const MAX_TERMINAL_SHORTCUTS: usize = 50;
const MAX_TERMINAL_SHORTCUT_LABEL_LEN: usize = 32;
const MAX_TERMINAL_SHORTCUT_PAYLOAD_LEN: usize = 256;
const TERMINAL_SHORTCUT_ACTIONS: [&str; 4] = [
    "paste",
    "toggleKeyboard",
    "newAgentSession",
    "scrollToBottom",
];

#[derive(Clone)]
pub struct HttpHandler {
    pub(super) repository: Repository,
    pub(super) config: GatewayConfig,
    pub(super) master_key: MasterKey,
    pub(super) runtime: Arc<dyn HttpRuntime>,
    pub(super) files: FileService,
    pub(super) watch_service: Option<WatchService>,
    pub(super) models_transport: Arc<dyn ModelsHttpTransport>,
    pub(super) agent_service: Option<Arc<dyn AgentHttpService>>,
    pub(super) telegram_service: Option<Arc<dyn TelegramHttpService>>,
    pub(super) weixin_service: Option<Arc<dyn WeixinHttpService>>,
    pub(super) update_registry: Arc<dyn UpdateRegistry>,
    pub(super) upgrade: Arc<UpgradeController>,
}

impl HttpHandler {
    pub fn new(
        repository: Repository,
        config: GatewayConfig,
        runtime: Arc<dyn HttpRuntime>,
        file_runtime: Arc<dyn FileRuntime>,
    ) -> Result<Self, CryptoError> {
        let master_key = config
            .master_key
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(MasterKey::from_base64)
            .transpose()?
            .unwrap_or_else(MasterKey::development_default);
        Ok(Self::with_master_key(
            repository,
            config,
            master_key,
            runtime,
            file_runtime,
        ))
    }

    pub fn with_master_key(
        repository: Repository,
        config: GatewayConfig,
        master_key: MasterKey,
        runtime: Arc<dyn HttpRuntime>,
        file_runtime: Arc<dyn FileRuntime>,
    ) -> Self {
        let files = FileService::new(repository.clone(), file_runtime, config.transfer_max_bytes);
        Self {
            repository,
            config,
            master_key,
            runtime,
            files,
            watch_service: None,
            models_transport: Arc::new(ReqwestModelsHttpTransport::default()),
            agent_service: None,
            telegram_service: None,
            weixin_service: None,
            update_registry: Arc::new(ReqwestUpdateRegistry::default()),
            upgrade: UpgradeController::production(),
        }
    }

    #[must_use]
    pub fn with_watch_service(mut self, watch_service: WatchService) -> Self {
        self.watch_service = Some(watch_service);
        self
    }

    #[must_use]
    pub fn with_models_transport(mut self, transport: Arc<dyn ModelsHttpTransport>) -> Self {
        self.models_transport = transport;
        self
    }

    #[must_use]
    pub fn with_agent_service(mut self, service: Arc<dyn AgentHttpService>) -> Self {
        self.agent_service = Some(service);
        self
    }

    #[must_use]
    pub fn with_telegram_service(mut self, service: Arc<dyn TelegramHttpService>) -> Self {
        self.telegram_service = Some(service);
        self
    }

    #[must_use]
    pub fn with_weixin_service(mut self, service: Arc<dyn WeixinHttpService>) -> Self {
        self.weixin_service = Some(service);
        self
    }

    #[must_use]
    pub fn with_update_registry(mut self, registry: Arc<dyn UpdateRegistry>) -> Self {
        self.update_registry = registry;
        self
    }

    #[must_use]
    pub fn with_upgrade_controller(mut self, upgrade: Arc<UpgradeController>) -> Self {
        self.upgrade = upgrade;
        self
    }

    pub async fn handle(&self, request: Request<Body>) -> HttpResponse {
        if request.uri().path() == "/api/files" || request.uri().path().starts_with("/api/files/") {
            return super::files::handle_files_request(self, request)
                .await
                .unwrap_or_else(|| {
                    error_json(StatusCode::NOT_FOUND, &self.translate("apiError.notFound"))
                });
        }
        let (parts, body) = request.into_parts();
        let body = match to_bytes(body, CORE_BODY_LIMIT).await {
            Ok(body) => body,
            Err(_) => return self.invalid_request_response(),
        };
        let request = Request::from_parts(parts, body);
        match self.dispatch(request).await {
            Ok(response) => response,
            Err(error) => error.into_response(),
        }
    }

    async fn dispatch(&self, request: Request<Bytes>) -> HandlerResult {
        let method = request.method().clone();
        let path = request.uri().path().to_owned();

        if path == "/api/capabilities" && method == Method::GET {
            return Ok(self.capabilities());
        }
        if path == "/api/devices" && method == Method::GET {
            return self.get_devices().await;
        }
        if path == "/api/devices" && method == Method::POST {
            return self.create_device(&request).await;
        }
        if path == "/api/devices/order" && method == Method::PUT {
            return self.reorder_devices(&request).await;
        }
        if let Some(response) = super::watch::handle_watch_request(self, &request).await? {
            return Ok(response);
        }
        if let Some(response) = super::llm::handle_llm_request(self, &request).await? {
            return Ok(response);
        }
        if let Some(response) = super::agent::handle_agent_request(self, &request).await? {
            return Ok(response);
        }
        if let Some(response) = super::telegram::handle_telegram_request(self, &request).await? {
            return Ok(response);
        }
        if let Some(response) = super::weixin::handle_weixin_request(self, &request).await? {
            return Ok(response);
        }

        let segments = path
            .strip_prefix('/')
            .unwrap_or(&path)
            .split('/')
            .collect::<Vec<_>>();
        match segments.as_slice() {
            ["api", "devices", raw_id] if method == Method::GET => {
                return self.get_device(&decode_component(raw_id)?).await;
            }
            ["api", "devices", raw_id] if method == Method::PATCH => {
                return self
                    .update_device(&request, &decode_component(raw_id)?)
                    .await;
            }
            ["api", "devices", raw_id] if method == Method::DELETE => {
                return self.delete_device(&decode_component(raw_id)?).await;
            }
            ["api", "devices", raw_id, "test-connection"] if method == Method::POST => {
                return self.test_connection(&decode_component(raw_id)?).await;
            }
            ["api", "devices", raw_id, "tree-order"] if method == Method::GET => {
                return self.get_tree_order(&decode_component(raw_id)?).await;
            }
            ["api", "devices", raw_id, "tree-order"] if method == Method::PUT => {
                return self
                    .put_tree_order(&request, &decode_component(raw_id)?)
                    .await;
            }
            ["api", "devices", raw_device_id, "windows", raw_window_id, "name"]
                if method == Method::PATCH =>
            {
                return self
                    .rename_window(
                        &request,
                        &decode_component(raw_device_id)?,
                        &decode_component(raw_window_id)?,
                    )
                    .await;
            }
            ["api", "devices", raw_device_id, "panes", raw_pane_id, "name"]
                if method == Method::PATCH =>
            {
                return self
                    .rename_pane(
                        &request,
                        &decode_component(raw_device_id)?,
                        &decode_component(raw_pane_id)?,
                    )
                    .await;
            }
            _ => {}
        }

        if path == "/api/tmux/tree" && method == Method::GET {
            return self.tmux_tree(request.uri()).await;
        }
        if path == "/api/settings/site" && method == Method::GET {
            return self.get_site_settings().await;
        }
        if path == "/api/settings/site" && method == Method::PATCH {
            return self.update_site_settings(&request).await;
        }
        if path == "/api/settings/terminal-shortcuts" && method == Method::GET {
            return self.get_terminal_shortcuts().await;
        }
        if path == "/api/settings/terminal-shortcuts" && method == Method::PATCH {
            return self.update_terminal_shortcuts(&request).await;
        }
        if path == "/api/settings/theme" && method == Method::GET {
            return self.get_theme().await;
        }
        if path == "/api/settings/theme" && method == Method::POST {
            return self.update_theme(&request).await;
        }
        if path == "/api/settings/restart" && method == Method::POST {
            return self.restart().await;
        }
        if path == "/api/manifest.webmanifest" && (method == Method::GET || method == Method::HEAD)
        {
            return self.manifest(method == Method::HEAD).await;
        }
        if path == "/healthz" && method == Method::GET {
            return self.health(&request).await;
        }
        if path == "/api/system/info" && method == Method::GET {
            return self.system_info().await;
        }
        if path == "/api/system/update-check" {
            if self.is_managed_externally() {
                return Ok(managed_system_response());
            }
            if method == Method::GET {
                return self.update_check().await;
            }
        }
        if path == "/api/system/upgrade" {
            if self.is_managed_externally() {
                return Ok(managed_system_response());
            }
            if method == Method::GET {
                return self.upgrade_status();
            }
            if method == Method::POST {
                return self.start_upgrade(&request).await;
            }
        }
        if path == "/api/webhooks" && method == Method::GET {
            return self.get_webhooks().await;
        }
        if path == "/api/webhooks" && method == Method::POST {
            return self.create_webhook(&request).await;
        }
        if let ["api", "webhooks", raw_id] = segments.as_slice() {
            if method == Method::DELETE {
                return self.delete_webhook(&decode_component(raw_id)?).await;
            }
        }

        Ok(error_json(
            StatusCode::NOT_FOUND,
            &self.translate("apiError.notFound"),
        ))
    }

    fn capabilities(&self) -> HttpResponse {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Capabilities<'a> {
            server_impl: &'static str,
            server_version: String,
            api_version: u8,
            ws_protocol_version: u16,
            capabilities: &'a [&'a str],
        }

        json(
            StatusCode::OK,
            &Capabilities {
                server_impl: "tmex-gateway",
                server_version: self.display_version(),
                api_version: API_VERSION,
                ws_protocol_version: tmex_protocol::CURRENT_VERSION,
                capabilities: &DEFAULT_CAPABILITIES,
            },
        )
    }

    async fn get_devices(&self) -> HandlerResult {
        let mut response = Vec::new();
        for device in self.repository.get_all_devices().await? {
            let runtime = self
                .repository
                .get_device_runtime_status(&device.id)
                .await?;
            response.push(DeviceWithRuntimeResponse::new(device, runtime));
        }
        Ok(json(StatusCode::OK, &json_value!({ "devices": response })))
    }

    async fn get_device(&self, id: &str) -> HandlerResult {
        let Some(device) = self.repository.get_device_by_id(id).await? else {
            return Ok(self.device_not_found());
        };
        let runtime = self.repository.get_device_runtime_status(id).await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "device": DeviceWithRuntimeResponse::new(device, runtime) }),
        ))
    }

    async fn create_device(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = self.body_object(request)?;
        let Some(name) = nonempty_string(body.get("name")) else {
            return Ok(self.missing_device_fields());
        };
        let Some(device_type) = nonempty_string(body.get("type")) else {
            return Ok(self.missing_device_fields());
        };
        let Some(auth_mode) = nonempty_string(body.get("authMode")) else {
            return Ok(self.missing_device_fields());
        };
        let host = optional_string(&body, "host")?;
        let ssh_config_ref = optional_string(&body, "sshConfigRef")?;
        if device_type == "ssh"
            && host.as_deref().is_none_or(str::is_empty)
            && ssh_config_ref.as_deref().is_none_or(str::is_empty)
        {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &self.translate("apiError.sshRequiresHost"),
            ));
        }

        let now = now_iso();
        let device = devices::Model {
            id: Uuid::new_v4().to_string(),
            name,
            r#type: device_type,
            host,
            port: Some(optional_i64(&body, "port")?.unwrap_or(22)),
            username: optional_string(&body, "username")?,
            ssh_config_ref,
            session: Some(optional_string(&body, "session")?.unwrap_or_else(|| "tmex".to_owned())),
            auth_mode,
            password_enc: self.encrypt_nonempty(&body, "password")?,
            private_key_enc: self.encrypt_nonempty(&body, "privateKey")?,
            private_key_passphrase_enc: self.encrypt_nonempty(&body, "privateKeyPassphrase")?,
            default_working_dir: optional_trimmed_string(&body, "defaultWorkingDir")?,
            sort_order: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        let id = device.id.clone();
        self.repository.create_device(device).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Devices)
            .await?;
        self.runtime.upsert_device(&id).await?;
        let stored = self
            .repository
            .get_device_by_id(&id)
            .await?
            .ok_or_else(|| HandlerError::InvalidRequest("failed to create device".to_owned()))?;
        Ok(json(
            StatusCode::CREATED,
            &json_value!({ "device": DeviceResponse::from(stored) }),
        ))
    }

    async fn update_device(&self, request: &Request<Bytes>, id: &str) -> HandlerResult {
        let Some(existing) = self.repository.get_device_by_id(id).await? else {
            return Ok(self.device_not_found());
        };
        let body = self.body_object(request)?;
        let mut updates = UpdateDevice::default();

        if let Some(value) = body.get("name") {
            updates.name = Some(required_string(value)?);
        }
        updates.host = nullable_string_update(&body, "host")?;
        updates.port = nullable_i64_update(&body, "port")?;
        updates.username = nullable_string_update(&body, "username")?;
        updates.ssh_config_ref = nullable_string_update(&body, "sshConfigRef")?;
        updates.session = nullable_string_update(&body, "session")?;
        if let Some(value) = body.get("authMode") {
            updates.auth_mode = Some(required_string(value)?);
        }
        if let Some(value) = body.get("password") {
            updates.password_enc = Some(Some(self.master_key.encrypt(&required_string(value)?)?));
        }
        if let Some(value) = body.get("privateKey") {
            updates.private_key_enc =
                Some(Some(self.master_key.encrypt(&required_string(value)?)?));
        }
        if let Some(value) = body.get("privateKeyPassphrase") {
            updates.private_key_passphrase_enc =
                Some(Some(self.master_key.encrypt(&required_string(value)?)?));
        }
        if let Some(value) = body.get("defaultWorkingDir") {
            updates.default_working_dir = Some(match value {
                JsonValue::Null => None,
                JsonValue::String(value) => nonempty_trimmed(value),
                _ => return Err(self.invalid_request_error()),
            });
        }

        let reconnect = should_reconnect(&existing, &updates);
        let working_dir_changed = updates
            .default_working_dir
            .as_ref()
            .is_some_and(|value| value != &existing.default_working_dir);
        let working_dir = updates.default_working_dir.clone().flatten();
        self.repository.update_device(id, updates).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Devices)
            .await?;
        if reconnect {
            self.runtime.reconnect_device(id).await?;
        } else if working_dir_changed {
            self.runtime
                .update_default_working_dir(id, working_dir)
                .await?;
        }

        let device = self
            .repository
            .get_device_by_id(id)
            .await?
            .map(DeviceResponse::from);
        Ok(json(StatusCode::OK, &json_value!({ "device": device })))
    }

    async fn reorder_devices(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = self.body_object(request)?;
        let Some(device_ids) = body.get("deviceIds").and_then(JsonValue::as_array) else {
            return Ok(self.invalid_request_response());
        };
        let Some(device_ids) = string_array(device_ids) else {
            return Ok(self.invalid_request_response());
        };
        self.repository.reorder_devices(&device_ids).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Devices)
            .await?;
        self.get_devices().await
    }

    async fn delete_device(&self, id: &str) -> HandlerResult {
        if self.repository.get_device_by_id(id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        self.repository.delete_device(id).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Devices)
            .await?;
        self.runtime.remove_device(id).await?;
        self.runtime.clear_connection_alert(id).await?;
        Ok(json(StatusCode::OK, &json_value!({ "success": true })))
    }

    async fn test_connection(&self, id: &str) -> HandlerResult {
        if self.repository.get_device_by_id(id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        let result = self.runtime.test_connection(id).await?;
        Ok(json(StatusCode::OK, &result))
    }

    async fn get_tree_order(&self, device_id: &str) -> HandlerResult {
        if self.repository.get_device_by_id(device_id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        let order = self.repository.get_device_tree_order(device_id).await?;
        let names = self
            .runtime
            .tree_custom_names(device_id)
            .await?
            .unwrap_or_default();
        Ok(json(
            StatusCode::OK,
            &json_value!({
                "deviceId": device_id,
                "windows": order.windows,
                "panes": order.panes,
                "windowNames": names.windows,
                "paneNames": names.panes,
            }),
        ))
    }

    async fn put_tree_order(&self, request: &Request<Bytes>, device_id: &str) -> HandlerResult {
        if self.repository.get_device_by_id(device_id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        let body = self.body_object(request)?;
        let windows = match body.get("windows") {
            None => None,
            Some(JsonValue::Array(values)) => string_array(values),
            Some(_) => None,
        };
        let panes = match body.get("panes") {
            None => None,
            Some(JsonValue::Object(values)) => {
                let mut panes = Vec::with_capacity(values.len());
                for (window_id, pane_ids) in values {
                    let Some(pane_ids) =
                        pane_ids.as_array().and_then(|values| string_array(values))
                    else {
                        return Ok(self.invalid_request_response());
                    };
                    panes.push((window_id.clone(), pane_ids));
                }
                Some(panes)
            }
            Some(_) => None,
        };
        if (body.contains_key("windows") && windows.is_none())
            || (body.contains_key("panes") && panes.is_none())
            || (windows.is_none() && panes.is_none())
        {
            return Ok(self.invalid_request_response());
        }
        if !self.runtime.tree_overlay_available() {
            return Ok(error_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "settings service not ready",
            ));
        }

        if let Some(window_ids) = windows {
            self.repository
                .set_window_order(device_id, &window_ids)
                .await?;
            self.runtime
                .tree_order_changed(TreeOrderChange::Windows {
                    device_id: device_id.to_owned(),
                    window_ids,
                })
                .await?;
        }
        if let Some(panes) = panes {
            for (window_id, pane_ids) in panes {
                self.repository
                    .set_pane_order(device_id, &window_id, &pane_ids)
                    .await?;
                self.runtime
                    .tree_order_changed(TreeOrderChange::Panes {
                        device_id: device_id.to_owned(),
                        window_id,
                        pane_ids,
                    })
                    .await?;
            }
        }
        let order = self.repository.get_device_tree_order(device_id).await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({
                "deviceId": device_id,
                "windows": order.windows,
                "panes": order.panes,
            }),
        ))
    }

    async fn rename_window(
        &self,
        request: &Request<Bytes>,
        device_id: &str,
        window_id: &str,
    ) -> HandlerResult {
        if self.repository.get_device_by_id(device_id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        let Some(name) = self.read_name(request)? else {
            return Ok(self.invalid_request_response());
        };
        if !self.runtime.tree_overlay_available() {
            return Ok(error_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "settings service not ready",
            ));
        }
        let normalized = normalize_custom_name(&name);
        self.runtime
            .rename_window(device_id, window_id, nonempty_owned(normalized.clone()))
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "deviceId": device_id, "windowId": window_id, "name": normalized }),
        ))
    }

    async fn rename_pane(
        &self,
        request: &Request<Bytes>,
        device_id: &str,
        pane_id: &str,
    ) -> HandlerResult {
        if self.repository.get_device_by_id(device_id).await?.is_none() {
            return Ok(self.device_not_found());
        }
        if !is_tmux_pane_id(pane_id) {
            return Ok(self.invalid_request_response());
        }
        let Some(name) = self.read_name(request)? else {
            return Ok(self.invalid_request_response());
        };
        if !self.runtime.tree_overlay_available() {
            return Ok(error_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "settings service not ready",
            ));
        }
        let normalized = normalize_custom_name(&name);
        self.runtime
            .rename_pane(device_id, pane_id, nonempty_owned(normalized.clone()))
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "deviceId": device_id, "paneId": pane_id, "name": normalized }),
        ))
    }

    async fn tmux_tree(&self, uri: &Uri) -> HandlerResult {
        let requested_device = query_parameter(uri, "deviceId");
        let devices = if let Some(device_id) = requested_device {
            let Some(device) = self.repository.get_device_by_id(&device_id).await? else {
                return Ok(self.device_not_found());
            };
            vec![device]
        } else {
            self.repository.get_all_devices().await?
        };

        let mut entries = Vec::with_capacity(devices.len());
        for device in devices {
            let session = match self.runtime.latest_snapshot(&device.id).await? {
                Some(mut snapshot) => {
                    let order = self.repository.get_device_tree_order(&device.id).await?;
                    apply_tree_order(&mut snapshot, &order.windows, &order.panes);
                    let names = self
                        .runtime
                        .tree_custom_names(&device.id)
                        .await?
                        .unwrap_or_default();
                    apply_custom_names(&mut snapshot, &names);
                    snapshot.session
                }
                None => None,
            };
            entries.push(json_value!({
                "deviceId": device.id,
                "deviceName": device.name,
                "session": session,
            }));
        }
        Ok(json(StatusCode::OK, &json_value!({ "devices": entries })))
    }

    async fn get_site_settings(&self) -> HandlerResult {
        let settings = self
            .repository
            .get_site_settings(&self.site_defaults())
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "settings": SiteSettingsResponse::from(settings) }),
        ))
    }

    async fn update_site_settings(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = self.body_object(request)?;
        let updates = match self.normalize_site_settings(body) {
            Ok(updates) => updates,
            Err(message) => return Ok(error_json(StatusCode::BAD_REQUEST, &message)),
        };
        let settings = self
            .repository
            .update_site_settings(&self.site_defaults(), updates)
            .await?;
        self.runtime
            .settings_changed(SettingsNamespace::Site)
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "settings": SiteSettingsResponse::from(settings) }),
        ))
    }

    async fn get_terminal_shortcuts(&self) -> HandlerResult {
        let defaults = default_terminal_shortcuts();
        let settings = self
            .repository
            .get_terminal_shortcut_settings(&defaults)
            .await?;
        Ok(terminal_shortcuts_response(settings))
    }

    async fn update_terminal_shortcuts(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = self.body_object(request)?;
        let (items, use_icons) = match self.normalize_terminal_shortcuts(body) {
            Ok(settings) => settings,
            Err(message) => return Ok(error_json(StatusCode::BAD_REQUEST, &message)),
        };
        let defaults = default_terminal_shortcuts();
        let settings = self
            .repository
            .update_terminal_shortcut_settings(&defaults, items, use_icons)
            .await?;
        self.runtime
            .settings_changed(SettingsNamespace::TerminalShortcuts)
            .await?;
        Ok(terminal_shortcuts_response(settings))
    }

    async fn get_theme(&self) -> HandlerResult {
        let settings = self
            .repository
            .get_site_settings(&self.site_defaults())
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "theme": settings.theme, "serverTimestamp": timestamp_ms() }),
        ))
    }

    async fn update_theme(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = match serde_json::from_slice::<JsonValue>(request.body()) {
            Ok(JsonValue::Object(body)) => body,
            _ => {
                return Ok(error_json(StatusCode::BAD_REQUEST, "invalid request body"));
            }
        };
        let theme = match body.get("theme").and_then(JsonValue::as_str) {
            Some("dark") => ThemeMode::Dark,
            Some("light") => ThemeMode::Light,
            _ => {
                return Ok(error_json(
                    StatusCode::BAD_REQUEST,
                    "theme must be one of: dark, light",
                ));
            }
        };
        let server_timestamp = timestamp_ms();
        self.repository
            .update_site_settings(
                &self.site_defaults(),
                SiteSettingsUpdate {
                    theme: Some(theme.as_str().to_owned()),
                    ..Default::default()
                },
            )
            .await?;
        self.runtime.theme_changed(theme).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Theme)
            .await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({ "theme": theme.as_str(), "serverTimestamp": server_timestamp }),
        ))
    }

    async fn restart(&self) -> HandlerResult {
        self.runtime.schedule_restart(RESTART_DELAY_MS).await?;
        Ok(json(
            StatusCode::OK,
            &json_value!({
                "success": true,
                "message": self.translate("settings.restartScheduled"),
            }),
        ))
    }

    async fn manifest(&self, head: bool) -> HandlerResult {
        let settings = self
            .repository
            .get_site_settings(&self.site_defaults())
            .await?;
        let value = json_value!({
            "id": "/",
            "name": settings.site_name,
            "short_name": settings.site_name,
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "background_color": "#0b1020",
            "theme_color": "#0b1020",
            "icons": [
                {
                    "src": "/tmex.png",
                    "sizes": "1024x1024",
                    "type": "image/png",
                    "purpose": "any",
                },
                {
                    "src": "/tmex-maskable.png",
                    "sizes": "1024x1024",
                    "type": "image/png",
                    "purpose": "maskable",
                },
            ],
        });
        Ok(manifest(&value, head))
    }

    async fn health(&self, request: &Request<Bytes>) -> HandlerResult {
        #[derive(Serialize)]
        struct Health<'a> {
            status: &'static str,
            restarting: bool,
            env: &'a str,
            tmux: TmuxHealth,
            owner: Option<GatewayOwnerProof>,
        }

        let tmux = self.runtime.tmux_health().await?;
        let challenge = request
            .headers()
            .get("x-tmex-gateway-challenge")
            .and_then(|value| value.to_str().ok());
        let owner = create_gateway_owner_proof(
            self.config.gateway_owner_token.as_deref(),
            challenge,
            std::process::id(),
            tmux.healthy,
        );
        Ok(json(
            StatusCode::OK,
            &Health {
                status: "ok",
                restarting: self.runtime.is_restarting(),
                env: &self.config.node_env,
                tmux,
                owner,
            },
        ))
    }

    async fn system_info(&self) -> HandlerResult {
        let info: SystemInfo = self.runtime.system_info().await?;
        Ok(json(StatusCode::OK, &info))
    }

    fn is_managed_externally(&self) -> bool {
        self.config.entry_mode == GatewayEntryMode::Embedded
            || self.config.management_mode != ManagementMode::None
            || self.config.update_owner != UpdateOwner::SelfManaged
    }

    async fn update_check(&self) -> HandlerResult {
        let info = self.runtime.system_info().await?;
        match check_for_update(self.update_registry.as_ref(), &info.base_version).await {
            Ok(result) => Ok(json(StatusCode::OK, &result)),
            Err(_) => Ok(error_json(
                StatusCode::BAD_GATEWAY,
                &self.translate("apiError.updateCheckFailed"),
            )),
        }
    }

    fn upgrade_status(&self) -> HandlerResult {
        Ok(json(StatusCode::OK, &self.upgrade.status()))
    }

    async fn start_upgrade(&self, request: &Request<Bytes>) -> HandlerResult {
        let info = self.runtime.system_info().await?;
        if !info.can_self_update {
            return Ok(error_json(
                StatusCode::FORBIDDEN,
                &self.translate("apiError.upgradeNotAllowed"),
            ));
        }
        let version = match serde_json::from_slice::<JsonValue>(request.body()) {
            Ok(JsonValue::Object(body)) => body
                .get("version")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .trim()
                .to_owned(),
            _ => String::new(),
        };
        if version.is_empty() {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &self.translate("apiError.upgradeVersionRequired"),
            ));
        }
        if !self.upgrade.start(version) {
            let mut body = serde_json::to_value(self.upgrade.status()).unwrap_or_else(|_| {
                json_value!({
                    "state": "downloading",
                    "targetVersion": null,
                    "error": null,
                    "startedAt": null,
                })
            });
            if let Some(object) = body.as_object_mut() {
                object.insert(
                    "error".to_owned(),
                    JsonValue::String(self.translate("apiError.upgradeInProgress")),
                );
            }
            return Ok(json(StatusCode::CONFLICT, &body));
        }
        Ok(json(StatusCode::OK, &self.upgrade.status()))
    }

    async fn get_webhooks(&self) -> HandlerResult {
        let webhooks = self
            .repository
            .get_all_webhook_endpoints()
            .await?
            .into_iter()
            .map(WebhookEndpointResponse::from)
            .collect::<Vec<_>>();
        Ok(json(StatusCode::OK, &json_value!({ "webhooks": webhooks })))
    }

    async fn create_webhook(&self, request: &Request<Bytes>) -> HandlerResult {
        let body = self.body_object(request)?;
        let Some(url) = nonempty_string(body.get("url")) else {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &self.translate("apiError.urlAndSecretRequired"),
            ));
        };
        let Some(secret) = nonempty_string(body.get("secret")) else {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &self.translate("apiError.urlAndSecretRequired"),
            ));
        };
        let enabled = match body.get("enabled") {
            None | Some(JsonValue::Null) => true,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| self.invalid_request_error())?,
        };
        let event_mask = match body.get("eventMask") {
            None | Some(JsonValue::Null) => Vec::new(),
            Some(JsonValue::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| self.invalid_request_error())
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err(self.invalid_request_error()),
        };
        let now = now_iso();
        let endpoint = webhook_endpoints::Model {
            id: Uuid::new_v4().to_string(),
            enabled: i64::from(enabled),
            url,
            secret,
            event_mask: serde_json::to_string(&event_mask)
                .map_err(|_| self.invalid_request_error())?,
            created_at: now.clone(),
            updated_at: now,
        };
        let response = WebhookEndpointResponse::from(endpoint.clone());
        self.repository.create_webhook_endpoint(endpoint).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Webhooks)
            .await?;
        Ok(json(
            StatusCode::CREATED,
            &json_value!({ "webhook": response }),
        ))
    }

    async fn delete_webhook(&self, id: &str) -> HandlerResult {
        self.repository.delete_webhook_endpoint(id).await?;
        self.runtime
            .settings_changed(SettingsNamespace::Webhooks)
            .await?;
        Ok(json(StatusCode::OK, &json_value!({ "success": true })))
    }

    fn body_object(
        &self,
        request: &Request<Bytes>,
    ) -> Result<JsonMap<String, JsonValue>, HandlerError> {
        match serde_json::from_slice::<JsonValue>(request.body()) {
            Ok(JsonValue::Object(body)) => Ok(body),
            _ => Err(self.invalid_request_error()),
        }
    }

    fn read_name(&self, request: &Request<Bytes>) -> Result<Option<String>, HandlerError> {
        let body = self.body_object(request)?;
        Ok(body
            .get("name")
            .and_then(JsonValue::as_str)
            .map(str::to_owned))
    }

    fn normalize_site_settings(
        &self,
        body: JsonMap<String, JsonValue>,
    ) -> Result<SiteSettingsUpdate, String> {
        let mut updates = SiteSettingsUpdate::default();
        if let Some(value) = body.get("siteName") {
            let value = value.as_str().unwrap_or_default().trim().to_owned();
            if value.is_empty() {
                return Err(self.translate("apiError.siteNameRequired"));
            }
            updates.site_name = Some(value);
        }
        if let Some(value) = body.get("siteUrl") {
            let value = value.as_str().unwrap_or_default().trim().to_owned();
            let lower = value.to_ascii_lowercase();
            if !lower.starts_with("http://") && !lower.starts_with("https://") {
                return Err(self.translate("apiError.siteUrlInvalid"));
            }
            updates.site_url = Some(value);
        }
        if let Some(value) = body.get("bellThrottleSeconds") {
            updates.bell_throttle_seconds =
                Some(self.number_in_range(value, 0, 300, "apiError.bellThrottleInvalid")?);
        }
        if let Some(value) = body.get("notificationThrottleSeconds") {
            updates.notification_throttle_seconds =
                Some(self.number_in_range(value, 0, 300, "apiError.bellThrottleInvalid")?);
        }
        if let Some(value) = body.get("enableBrowserNotificationToast") {
            updates.enable_browser_notification_toast = Some(
                value
                    .as_bool()
                    .ok_or_else(|| self.translate("apiError.invalidRequest"))?,
            );
        }
        if let Some(value) = body.get("enableNotificationPush") {
            updates.enable_notification_push = Some(
                value
                    .as_bool()
                    .ok_or_else(|| self.translate("apiError.invalidRequest"))?,
            );
        }
        if let Some(value) = body.get("enableBellPush") {
            updates.enable_bell_push = Some(
                value
                    .as_bool()
                    .ok_or_else(|| self.translate("apiError.invalidRequest"))?,
            );
        }
        if let Some(value) = body.get("enableBellSound") {
            updates.enable_bell_sound = Some(
                value
                    .as_bool()
                    .ok_or_else(|| self.translate("apiError.invalidRequest"))?,
            );
        }
        if let Some(value) = body.get("sshReconnectMaxRetries") {
            updates.ssh_reconnect_max_retries =
                Some(self.number_in_range(value, 0, 20, "apiError.sshRetriesInvalid")?);
        }
        if let Some(value) = body.get("sshReconnectDelaySeconds") {
            updates.ssh_reconnect_delay_seconds =
                Some(self.number_in_range(value, 1, 300, "apiError.sshDelayInvalid")?);
        }
        if let Some(value) = body.get("language") {
            let value = value.as_str().unwrap_or_default().trim();
            if !matches!(value, "en_US" | "zh_CN" | "ja_JP") {
                return Err(self.translate("apiError.languageInvalid"));
            }
            updates.language = Some(value.to_owned());
        }
        if let Some(value) = body.get("disabledNotificationChannels") {
            let Some(values) = value.as_array().and_then(|values| string_array(values)) else {
                return Err(self.translate("apiError.invalidRequest"));
            };
            let mut seen = HashSet::new();
            updates.disabled_notification_channels = Some(
                values
                    .into_iter()
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty() && seen.insert(value.clone()))
                    .collect(),
            );
        }
        Ok(updates)
    }

    fn normalize_terminal_shortcuts(
        &self,
        body: JsonMap<String, JsonValue>,
    ) -> Result<(Json, bool), String> {
        let use_icons = body
            .get("useIcons")
            .and_then(JsonValue::as_bool)
            .ok_or_else(|| self.translate("apiError.invalidRequest"))?;
        let items = body
            .get("items")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| self.translate("apiError.invalidRequest"))?;
        if items.len() > MAX_TERMINAL_SHORTCUTS {
            return Err(self.translate("apiError.terminalShortcutsTooMany"));
        }

        let invalid = || self.translate("apiError.terminalShortcutInvalid");
        let mut seen = HashSet::new();
        let mut normalized = Vec::with_capacity(items.len());
        for raw in items {
            let item = raw.as_object().ok_or_else(&invalid)?;
            let id = item
                .get("id")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if id.is_empty() || !seen.insert(id.clone()) {
                return Err(invalid());
            }
            let label = item
                .get("label")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_owned();
            if utf16_len(&label) > MAX_TERMINAL_SHORTCUT_LABEL_LEN {
                return Err(invalid());
            }
            match item.get("type").and_then(JsonValue::as_str) {
                Some("send") => {
                    let payload = item
                        .get("payload")
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if payload.is_empty() || utf16_len(&payload) > MAX_TERMINAL_SHORTCUT_PAYLOAD_LEN
                    {
                        return Err(invalid());
                    }
                    normalized.push(json_value!({
                        "id": id,
                        "type": "send",
                        "label": label,
                        "payload": payload,
                    }));
                }
                Some("action") => {
                    let action = item
                        .get("action")
                        .and_then(JsonValue::as_str)
                        .filter(|action| TERMINAL_SHORTCUT_ACTIONS.contains(action))
                        .ok_or_else(&invalid)?;
                    normalized.push(json_value!({
                        "id": id,
                        "type": "action",
                        "label": label,
                        "action": action,
                    }));
                }
                _ => return Err(invalid()),
            }
        }
        Ok((JsonValue::Array(normalized), use_icons))
    }

    fn number_in_range(
        &self,
        value: &JsonValue,
        minimum: i64,
        maximum: i64,
        error_key: &'static str,
    ) -> Result<i64, String> {
        let Some(value) = js_number(value) else {
            return Err(self.translate(error_key));
        };
        let value = value.floor();
        if !value.is_finite() || value < minimum as f64 || value > maximum as f64 {
            return Err(self.translate(error_key));
        }
        Ok(value as i64)
    }

    fn encrypt_nonempty(
        &self,
        body: &JsonMap<String, JsonValue>,
        field: &str,
    ) -> Result<Option<String>, HandlerError> {
        match body.get(field) {
            None | Some(JsonValue::Null) => Ok(None),
            Some(JsonValue::String(value)) if value.is_empty() => Ok(None),
            Some(JsonValue::String(value)) => Ok(Some(self.master_key.encrypt(value)?)),
            Some(_) => Err(self.invalid_request_error()),
        }
    }

    pub(super) fn site_defaults(&self) -> RepositorySiteSettingsDefaults {
        RepositorySiteSettingsDefaults {
            site_name: self.config.site_name_default.clone(),
            site_url: self.config.base_url.clone(),
            bell_throttle_seconds: self.config.bell_throttle_seconds_default as i64,
            notification_throttle_seconds: self.config.notification_throttle_seconds_default as i64,
            ssh_reconnect_max_retries: self.config.ssh_reconnect_max_retries_default as i64,
            ssh_reconnect_delay_seconds: self.config.ssh_reconnect_delay_seconds_default as i64,
            language: self.config.language_default.clone(),
        }
    }

    fn display_version(&self) -> String {
        if self.config.is_prod() {
            GATEWAY_VERSION.to_owned()
        } else {
            format!("{GATEWAY_VERSION}_dev")
        }
    }

    pub(super) fn translate(&self, key: &'static str) -> String {
        self.runtime.translate(key)
    }

    fn invalid_request_error(&self) -> HandlerError {
        HandlerError::InvalidRequest(self.translate("apiError.invalidRequest"))
    }

    fn invalid_request_response(&self) -> HttpResponse {
        error_json(
            StatusCode::BAD_REQUEST,
            &self.translate("apiError.invalidRequest"),
        )
    }

    fn device_not_found(&self) -> HttpResponse {
        error_json(
            StatusCode::NOT_FOUND,
            &self.translate("apiError.deviceNotFound"),
        )
    }

    fn missing_device_fields(&self) -> HttpResponse {
        error_json(
            StatusCode::BAD_REQUEST,
            &self.translate("apiError.missingFields"),
        )
    }
}

fn managed_system_response() -> HttpResponse {
    json(
        StatusCode::FORBIDDEN,
        &json_value!({
            "error": "managed_externally",
            "managed": true,
            "canSelfUpdate": false,
        }),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebhookEndpointResponse {
    id: String,
    enabled: bool,
    url: String,
    secret: String,
    event_mask: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl From<webhook_endpoints::Model> for WebhookEndpointResponse {
    fn from(endpoint: webhook_endpoints::Model) -> Self {
        Self {
            id: endpoint.id,
            enabled: endpoint.enabled != 0,
            url: endpoint.url,
            secret: endpoint.secret,
            event_mask: serde_json::from_str(&endpoint.event_mask).unwrap_or_default(),
            created_at: endpoint.created_at,
            updated_at: endpoint.updated_at,
        }
    }
}

fn terminal_shortcuts_response(settings: TerminalShortcutSettingsRecord) -> HttpResponse {
    json(
        StatusCode::OK,
        &json_value!({ "settings": TerminalShortcutSettingsResponse::from(settings) }),
    )
}

fn now_iso() -> String {
    let now: ChronoDateTimeUtc = SystemTime::now().into();
    now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn decode_component(value: &str) -> Result<String, HandlerError> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| HandlerError::InvalidRequest("Invalid request".to_owned()))
}

fn query_parameter(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(key)?;
        if key == name {
            decode_query_component(value)
        } else {
            None
        }
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    let value = value.replace('+', " ");
    percent_decode_str(&value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn nonempty_string(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn required_string(value: &JsonValue) -> Result<String, HandlerError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| HandlerError::InvalidRequest("Invalid request".to_owned()))
}

fn optional_string(
    body: &JsonMap<String, JsonValue>,
    key: &str,
) -> Result<Option<String>, HandlerError> {
    match body.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(HandlerError::InvalidRequest("Invalid request".to_owned())),
    }
}

fn optional_trimmed_string(
    body: &JsonMap<String, JsonValue>,
    key: &str,
) -> Result<Option<String>, HandlerError> {
    optional_string(body, key).map(|value| value.and_then(|value| nonempty_trimmed(&value)))
}

fn optional_i64(body: &JsonMap<String, JsonValue>, key: &str) -> Result<Option<i64>, HandlerError> {
    match body.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Number(value)) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| HandlerError::InvalidRequest("Invalid request".to_owned())),
        Some(_) => Err(HandlerError::InvalidRequest("Invalid request".to_owned())),
    }
}

fn nullable_string_update(
    body: &JsonMap<String, JsonValue>,
    key: &str,
) -> Result<Option<Option<String>>, HandlerError> {
    match body.get(key) {
        None => Ok(None),
        Some(JsonValue::Null) => Ok(Some(None)),
        Some(JsonValue::String(value)) => Ok(Some(Some(value.clone()))),
        Some(_) => Err(HandlerError::InvalidRequest("Invalid request".to_owned())),
    }
}

fn nullable_i64_update(
    body: &JsonMap<String, JsonValue>,
    key: &str,
) -> Result<Option<Option<i64>>, HandlerError> {
    match body.get(key) {
        None => Ok(None),
        Some(JsonValue::Null) => Ok(Some(None)),
        Some(JsonValue::Number(value)) => value
            .as_i64()
            .map(|value| Some(Some(value)))
            .ok_or_else(|| HandlerError::InvalidRequest("Invalid request".to_owned())),
        Some(_) => Err(HandlerError::InvalidRequest("Invalid request".to_owned())),
    }
}

fn should_reconnect(existing: &devices::Model, updates: &UpdateDevice) -> bool {
    updates
        .host
        .as_ref()
        .is_some_and(|value| value != &existing.host)
        || updates
            .port
            .as_ref()
            .is_some_and(|value| value != &existing.port)
        || updates
            .username
            .as_ref()
            .is_some_and(|value| value != &existing.username)
        || updates
            .ssh_config_ref
            .as_ref()
            .is_some_and(|value| value != &existing.ssh_config_ref)
        || updates
            .session
            .as_ref()
            .is_some_and(|value| value != &existing.session)
        || updates
            .auth_mode
            .as_ref()
            .is_some_and(|value| value != &existing.auth_mode)
        || updates.password_enc.is_some()
        || updates.private_key_enc.is_some()
        || updates.private_key_passphrase_enc.is_some()
}

fn string_array(values: &[JsonValue]) -> Option<Vec<String>> {
    values
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn nonempty_trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn nonempty_owned(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn normalize_custom_name(value: &str) -> String {
    value.trim().chars().take(64).collect()
}

fn js_number(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Null => Some(0.0),
        JsonValue::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        JsonValue::Number(value) => value.as_f64(),
        JsonValue::String(value) if value.trim().is_empty() => Some(0.0),
        JsonValue::String(value) => value.trim().parse().ok(),
        JsonValue::Array(values) if values.is_empty() => Some(0.0),
        _ => None,
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn default_terminal_shortcuts() -> Json {
    json_value!([
        { "id": "paste", "type": "action", "action": "paste", "label": "" },
        { "id": "enter", "type": "send", "label": "Enter", "payload": "\r" },
        { "id": "shift-tab", "type": "send", "label": "SHIFT-TAB", "payload": "\u{1b}[Z" },
        { "id": "esc", "type": "send", "label": "ESC", "payload": "\u{1b}" },
        { "id": "ctrl-c", "type": "send", "label": "CTRL-C", "payload": "\u{3}" },
        { "id": "ctrl-d", "type": "send", "label": "CTRL-D", "payload": "\u{4}" },
        { "id": "arrow-up", "type": "send", "label": "↑", "payload": "\u{1b}[A" },
        { "id": "arrow-down", "type": "send", "label": "↓", "payload": "\u{1b}[B" },
        { "id": "arrow-left", "type": "send", "label": "←", "payload": "\u{1b}[D" },
        { "id": "arrow-right", "type": "send", "label": "→", "payload": "\u{1b}[C" },
        { "id": "shift-enter", "type": "send", "label": "SHIFT-Enter", "payload": "\u{1b}[13;2u" },
        { "id": "backspace", "type": "send", "label": "Backspace", "payload": "\u{8}" },
    ])
}

fn apply_tree_order(
    snapshot: &mut StateSnapshot,
    window_ids: &[String],
    pane_ids: &BTreeMap<String, Vec<String>>,
) {
    let Some(session) = snapshot.session.as_mut() else {
        return;
    };
    reorder_by_id(&mut session.windows, window_ids, |window| &window.id);
    for window in &mut session.windows {
        if let Some(order) = pane_ids.get(&window.id) {
            reorder_by_id(&mut window.panes, order, |pane| &pane.id);
        }
    }
}

fn reorder_by_id<T, F>(items: &mut Vec<T>, saved_ids: &[String], id: F)
where
    F: Fn(&T) -> &str,
{
    if saved_ids.is_empty() {
        return;
    }
    let mut remaining = std::mem::take(items);
    let mut ordered = Vec::with_capacity(remaining.len());
    for saved_id in saved_ids {
        if let Some(index) = remaining.iter().position(|item| id(item) == saved_id) {
            ordered.push(remaining.remove(index));
        }
    }
    ordered.extend(remaining);
    *items = ordered;
}

fn apply_custom_names(snapshot: &mut StateSnapshot, names: &TreeCustomNames) {
    let Some(session) = snapshot.session.as_mut() else {
        return;
    };
    for window in &mut session.windows {
        if let Some(name) = names
            .windows
            .get(&window.id)
            .filter(|name| !name.is_empty())
        {
            window.custom_name = Some(name.clone());
        }
        for pane in &mut window.panes {
            if let Some(name) = names.panes.get(&pane.id).filter(|name| !name.is_empty()) {
                pane.custom_name = Some(name.clone());
            }
        }
    }
}
