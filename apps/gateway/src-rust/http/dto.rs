use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::database::repository::TerminalShortcutSettingsRecord;
use crate::entity::{device_runtime_status, devices, site_settings};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsNamespace {
    Devices,
    FileRoots,
    Llm,
    Site,
    Telegram,
    TerminalShortcuts,
    Theme,
    Weixin,
    Webhooks,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThemeMode {
    Dark,
    Light,
}

impl ThemeMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TreeOrderChange {
    Windows {
        device_id: String,
        window_ids: Vec<String>,
    },
    Panes {
        device_id: String,
        window_id: String,
        pane_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeCustomNames {
    pub windows: BTreeMap<String, String>,
    pub panes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub tmux_available: bool,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxHealth {
    pub healthy: bool,
    pub client_version: Option<String>,
    pub client_provenance: Option<String>,
    pub server_version: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub version: String,
    pub base_version: String,
    pub is_prod: bool,
    pub installed_via_cli: bool,
    pub deployment: String,
    pub can_self_update: bool,
    pub service_name: Option<String>,
    #[serde(serialize_with = "serialize_js_number")]
    pub transfer_max_bytes: f64,
    pub terminal_paste_max_bytes: u64,
    pub paste_image_max_bytes: u64,
    pub management_mode: String,
    pub update_owner: String,
}

fn serialize_js_number<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value.is_finite() {
        serializer.serialize_f64(*value)
    } else {
        serializer.serialize_none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResponse {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub device_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_config_ref: Option<String>,
    pub session: String,
    pub auth_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key_passphrase_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_working_dir: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl From<devices::Model> for DeviceResponse {
    fn from(model: devices::Model) -> Self {
        Self {
            id: model.id,
            name: model.name,
            device_type: model.r#type,
            host: model.host,
            port: model.port,
            username: model.username,
            ssh_config_ref: model.ssh_config_ref,
            session: model.session.unwrap_or_else(|| "tmex".to_owned()),
            auth_mode: model.auth_mode,
            password_enc: model.password_enc,
            private_key_enc: model.private_key_enc,
            private_key_passphrase_enc: model.private_key_passphrase_enc,
            default_working_dir: model.default_working_dir,
            sort_order: model.sort_order,
            created_at: model.created_at,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWithRuntimeResponse {
    #[serde(flatten)]
    pub device: DeviceResponse,
    pub last_seen_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_type: Option<String>,
    pub tmux_available: bool,
}

impl DeviceWithRuntimeResponse {
    pub fn new(device: devices::Model, runtime: device_runtime_status::Model) -> Self {
        Self {
            device: device.into(),
            last_seen_at: runtime.last_seen_at,
            last_error: runtime.last_error,
            last_error_type: runtime.last_error_type,
            tmux_available: runtime.tmux_available != 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSettingsResponse {
    pub site_name: String,
    pub site_url: String,
    pub bell_throttle_seconds: i64,
    pub notification_throttle_seconds: i64,
    pub enable_browser_notification_toast: bool,
    pub enable_notification_push: bool,
    pub enable_bell_push: bool,
    pub enable_bell_sound: bool,
    pub ssh_reconnect_max_retries: i64,
    pub ssh_reconnect_delay_seconds: i64,
    pub language: String,
    pub theme: String,
    pub disabled_notification_channels: Vec<String>,
    pub updated_at: String,
}

impl From<site_settings::Model> for SiteSettingsResponse {
    fn from(model: site_settings::Model) -> Self {
        let disabled_notification_channels =
            serde_json::from_str::<Vec<String>>(&model.disabled_notification_channels)
                .unwrap_or_default();
        Self {
            site_name: model.site_name,
            site_url: model.site_url,
            bell_throttle_seconds: model.bell_throttle_seconds,
            notification_throttle_seconds: model.notification_throttle_seconds,
            enable_browser_notification_toast: model.enable_browser_notification_toast != 0,
            enable_notification_push: model.enable_notification_push != 0,
            enable_bell_push: model.enable_bell_push != 0,
            enable_bell_sound: model.enable_bell_sound != 0,
            ssh_reconnect_max_retries: model.ssh_reconnect_max_retries,
            ssh_reconnect_delay_seconds: model.ssh_reconnect_delay_seconds,
            language: model.language,
            theme: model.theme,
            disabled_notification_channels,
            updated_at: model.updated_at,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShortcutSettingsResponse {
    pub items: JsonValue,
    pub use_icons: bool,
    pub updated_at: String,
}

impl From<TerminalShortcutSettingsRecord> for TerminalShortcutSettingsResponse {
    fn from(record: TerminalShortcutSettingsRecord) -> Self {
        Self {
            items: record.items,
            use_icons: record.use_icons,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub device_id: String,
    pub session: Option<TmuxSession>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub id: String,
    pub name: String,
    pub windows: Vec<TmuxWindow>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    pub index: i64,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    pub panes: Vec<TmuxPane>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPane {
    pub id: String,
    pub window_id: String,
    pub index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_path: Option<String>,
    pub active: bool,
    pub width: i64,
    pub height: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<i64>,
}
