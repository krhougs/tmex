use std::collections::BTreeMap;

use sea_orm::entity::prelude::Json;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set};

use crate::entity::{
    device_runtime_status, device_tree_order, devices, gateway_kv, site_settings,
    telegram_bot_chats, telegram_bots, terminal_shortcut_settings, webhook_endpoints,
    weixin_account_users, weixin_accounts,
};

use super::{
    bool_value, json_string_list, json_string_map, new_id, now_iso, parse_string_list,
    parse_string_map, rollback, Repository, RepositoryError, RepositoryResult,
    DEFAULT_LOCAL_DEVICE_SEED_KEY,
};

const TELEGRAM_CHAT_CAP: u64 = 8;
const WEIXIN_USER_CAP: u64 = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositorySiteSettingsDefaults {
    pub site_name: String,
    pub site_url: String,
    pub bell_throttle_seconds: i64,
    pub notification_throttle_seconds: i64,
    pub ssh_reconnect_max_retries: i64,
    pub ssh_reconnect_delay_seconds: i64,
    pub language: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SiteSettingsUpdate {
    pub site_name: Option<String>,
    pub site_url: Option<String>,
    pub bell_throttle_seconds: Option<i64>,
    pub notification_throttle_seconds: Option<i64>,
    pub enable_browser_notification_toast: Option<bool>,
    pub enable_notification_push: Option<bool>,
    pub enable_bell_push: Option<bool>,
    pub enable_bell_sound: Option<bool>,
    pub ssh_reconnect_max_retries: Option<i64>,
    pub ssh_reconnect_delay_seconds: Option<i64>,
    pub language: Option<String>,
    pub theme: Option<String>,
    pub disabled_notification_channels: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateDevice {
    pub name: Option<String>,
    pub host: Option<Option<String>>,
    pub port: Option<Option<i64>>,
    pub username: Option<Option<String>>,
    pub ssh_config_ref: Option<Option<String>>,
    pub session: Option<Option<String>>,
    pub auth_mode: Option<String>,
    pub password_enc: Option<Option<String>>,
    pub private_key_enc: Option<Option<String>>,
    pub private_key_passphrase_enc: Option<Option<String>>,
    pub default_working_dir: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceTreeOrderRecord {
    pub device_id: String,
    pub windows: Vec<String>,
    pub panes: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceRuntimeStatusUpdate {
    pub last_seen_at: Option<Option<String>>,
    pub tmux_available: Option<bool>,
    pub last_error: Option<Option<String>>,
    pub last_error_type: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalShortcutSettingsRecord {
    pub items: Json,
    pub use_icons: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelegramBotStats {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub allow_auth_requests: bool,
    pub created_at: String,
    pub updated_at: String,
    pub pending_count: u64,
    pub authorized_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TelegramBotUpdate {
    pub name: Option<String>,
    pub token_enc: Option<String>,
    pub enabled: Option<bool>,
    pub allow_auth_requests: Option<bool>,
    pub last_update_id: Option<Option<i64>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatePendingTelegramChatInput {
    pub bot_id: String,
    pub chat_id: String,
    pub chat_type: String,
    pub display_name: String,
    pub applied_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeixinAccountStats {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub allow_auth_requests: bool,
    pub logged_in: bool,
    pub created_at: String,
    pub updated_at: String,
    pub pending_count: u64,
    pub authorized_count: u64,
    pub needs_reactivation_count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WeixinAccountUpdate {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub allow_auth_requests: Option<bool>,
    pub weixin_uin: Option<Option<String>>,
    pub bot_token_enc: Option<Option<String>>,
    pub base_url: Option<Option<String>>,
    pub sync_buf: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpsertWeixinUserInput {
    pub account_id: String,
    pub user_id: String,
    pub display_name: String,
    pub context_token: Option<String>,
    pub allow_auth_requests: bool,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeixinContextToken {
    pub user_id: String,
    pub context_token: String,
}

fn normalize_locale(value: &str) -> String {
    match value {
        "zh_CN" => "zh_CN".to_owned(),
        "ja_JP" => "ja_JP".to_owned(),
        _ => "en_US".to_owned(),
    }
}

impl Repository {
    pub async fn ensure_site_settings_initialized(
        &self,
        defaults: &RepositorySiteSettingsDefaults,
    ) -> RepositoryResult<()> {
        site_settings::Entity::insert(site_settings::ActiveModel {
            id: Set(1),
            site_name: Set(defaults.site_name.clone()),
            site_url: Set(defaults.site_url.clone()),
            bell_throttle_seconds: Set(defaults.bell_throttle_seconds),
            notification_throttle_seconds: Set(defaults.notification_throttle_seconds),
            enable_browser_notification_toast: Set(1),
            enable_notification_push: Set(1),
            enable_bell_push: Set(1),
            enable_bell_sound: Set(1),
            ssh_reconnect_max_retries: Set(defaults.ssh_reconnect_max_retries),
            ssh_reconnect_delay_seconds: Set(defaults.ssh_reconnect_delay_seconds),
            language: Set(normalize_locale(&defaults.language)),
            disabled_notification_channels: Set("[]".to_owned()),
            updated_at: Set(now_iso()),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(site_settings::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_gateway_kv(&self, key: &str) -> RepositoryResult<Option<String>> {
        Ok(gateway_kv::Entity::find_by_id(key.to_owned())
            .one(self.database.orm())
            .await?
            .map(|row| row.value))
    }

    pub async fn set_gateway_kv(&self, key: &str, value: &str) -> RepositoryResult<()> {
        gateway_kv::Entity::insert(gateway_kv::ActiveModel {
            key: Set(key.to_owned()),
            value: Set(value.to_owned()),
            updated_at: Set(now_iso()),
        })
        .on_conflict(
            OnConflict::column(gateway_kv::Column::Key)
                .update_columns([gateway_kv::Column::Value, gateway_kv::Column::UpdatedAt])
                .to_owned(),
        )
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn ensure_default_local_device_seeded(&self, hostname: &str) -> RepositoryResult<()> {
        let transaction = self.database.begin().await?;
        let result = async {
            if gateway_kv::Entity::find_by_id(DEFAULT_LOCAL_DEVICE_SEED_KEY.to_owned())
                .one(transaction.orm())
                .await?
                .is_some()
            {
                return RepositoryResult::Ok(());
            }
            let has_site_settings = site_settings::Entity::find()
                .select_only()
                .column(site_settings::Column::Id)
                .into_tuple::<i64>()
                .one(transaction.orm())
                .await?
                .is_some();
            let has_devices = devices::Entity::find()
                .select_only()
                .column(devices::Column::Id)
                .into_tuple::<String>()
                .one(transaction.orm())
                .await?
                .is_some();
            if !has_site_settings && !has_devices {
                let now = now_iso();
                let name = hostname.trim();
                let device_id = new_id();
                devices::Entity::insert(devices::ActiveModel {
                    id: Set(device_id.clone()),
                    name: Set(if name.is_empty() {
                        "local".to_owned()
                    } else {
                        name.to_owned()
                    }),
                    r#type: Set("local".to_owned()),
                    host: Set(None),
                    port: Set(Some(22)),
                    username: Set(None),
                    ssh_config_ref: Set(None),
                    session: Set(Some("tmex".to_owned())),
                    auth_mode: Set("auto".to_owned()),
                    password_enc: Set(None),
                    private_key_enc: Set(None),
                    private_key_passphrase_enc: Set(None),
                    default_working_dir: Set(None),
                    sort_order: Set(0),
                    created_at: Set(now.clone()),
                    updated_at: Set(now),
                })
                .exec_without_returning(transaction.orm())
                .await?;
                device_runtime_status::Entity::insert(device_runtime_status::ActiveModel {
                    device_id: Set(device_id),
                    last_seen_at: Set(None),
                    tmux_available: Set(0),
                    last_error: Set(None),
                    last_error_type: Set(None),
                })
                .on_conflict(
                    OnConflict::column(device_runtime_status::Column::DeviceId)
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(transaction.orm())
                .await?;
            }
            gateway_kv::Entity::insert(gateway_kv::ActiveModel {
                key: Set(DEFAULT_LOCAL_DEVICE_SEED_KEY.to_owned()),
                value: Set("1".to_owned()),
                updated_at: Set(now_iso()),
            })
            .on_conflict(
                OnConflict::column(gateway_kv::Column::Key)
                    .update_columns([gateway_kv::Column::Value, gateway_kv::Column::UpdatedAt])
                    .to_owned(),
            )
            .exec_without_returning(transaction.orm())
            .await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn create_device(&self, mut device: devices::Model) -> RepositoryResult<()> {
        let transaction = self.database.begin().await?;
        let result = async {
            let max_sort_order = devices::Entity::find()
                .select_only()
                .column_as(devices::Column::SortOrder.max(), "max_sort_order")
                .into_tuple::<Option<i64>>()
                .one(transaction.orm())
                .await?
                .flatten()
                .unwrap_or(-1);
            device.port = Some(device.port.unwrap_or(22));
            device.session = Some(device.session.unwrap_or_else(|| "tmex".to_owned()));
            device.sort_order = max_sort_order + 1;
            devices::Entity::insert(devices::ActiveModel {
                id: Set(device.id.clone()),
                name: Set(device.name.clone()),
                r#type: Set(device.r#type.clone()),
                host: Set(device.host.clone()),
                port: Set(device.port),
                username: Set(device.username.clone()),
                ssh_config_ref: Set(device.ssh_config_ref.clone()),
                session: Set(device.session.clone()),
                auth_mode: Set(device.auth_mode.clone()),
                password_enc: Set(device.password_enc.clone()),
                private_key_enc: Set(device.private_key_enc.clone()),
                private_key_passphrase_enc: Set(device.private_key_passphrase_enc.clone()),
                default_working_dir: Set(device.default_working_dir.clone()),
                sort_order: Set(device.sort_order),
                created_at: Set(device.created_at.clone()),
                updated_at: Set(device.updated_at.clone()),
            })
            .exec_without_returning(transaction.orm())
            .await?;
            device_runtime_status::Entity::insert(device_runtime_status::ActiveModel {
                device_id: Set(device.id.clone()),
                last_seen_at: Set(None),
                tmux_available: Set(0),
                last_error: Set(None),
                last_error_type: Set(None),
            })
            .on_conflict(
                OnConflict::column(device_runtime_status::Column::DeviceId)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(transaction.orm())
            .await?;
            RepositoryResult::Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn get_device_by_id(&self, id: &str) -> RepositoryResult<Option<devices::Model>> {
        Ok(devices::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_devices(&self) -> RepositoryResult<Vec<devices::Model>> {
        Ok(devices::Entity::find()
            .order_by_asc(devices::Column::SortOrder)
            .order_by_desc(devices::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn reorder_devices(&self, ordered_ids: &[String]) -> RepositoryResult<()> {
        let transaction = self.database.begin().await?;
        let now = now_iso();
        let result = async {
            for (index, id) in ordered_ids.iter().enumerate() {
                devices::Entity::update_many()
                    .set(devices::ActiveModel {
                        sort_order: Set(index as i64),
                        updated_at: Set(now.clone()),
                        ..Default::default()
                    })
                    .filter(devices::Column::Id.eq(id))
                    .exec(transaction.orm())
                    .await?;
            }
            RepositoryResult::Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn update_device(&self, id: &str, updates: UpdateDevice) -> RepositoryResult<()> {
        let mut model = devices::ActiveModel {
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.name {
            model.name = Set(value);
        }
        if let Some(value) = updates.host {
            model.host = Set(value);
        }
        if let Some(value) = updates.port {
            model.port = Set(value);
        }
        if let Some(value) = updates.username {
            model.username = Set(value);
        }
        if let Some(value) = updates.ssh_config_ref {
            model.ssh_config_ref = Set(value);
        }
        if let Some(value) = updates.session {
            model.session = Set(value);
        }
        if let Some(value) = updates.auth_mode {
            model.auth_mode = Set(value);
        }
        if let Some(value) = updates.password_enc {
            model.password_enc = Set(value);
        }
        if let Some(value) = updates.private_key_enc {
            model.private_key_enc = Set(value);
        }
        if let Some(value) = updates.private_key_passphrase_enc {
            model.private_key_passphrase_enc = Set(value);
        }
        if let Some(value) = updates.default_working_dir {
            model.default_working_dir = Set(value.filter(|value| !value.is_empty()));
        }
        devices::Entity::update_many()
            .set(model)
            .filter(devices::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn delete_device(&self, id: &str) -> RepositoryResult<()> {
        devices::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn get_device_tree_order(
        &self,
        device_id: &str,
    ) -> RepositoryResult<DeviceTreeOrderRecord> {
        let Some(row) = device_tree_order::Entity::find_by_id(device_id.to_owned())
            .one(self.database.orm())
            .await?
        else {
            return Ok(DeviceTreeOrderRecord {
                device_id: device_id.to_owned(),
                windows: Vec::new(),
                panes: BTreeMap::new(),
            });
        };
        Ok(DeviceTreeOrderRecord {
            device_id: row.device_id,
            windows: parse_string_list(&row.windows, "device_tree_order.windows")
                .unwrap_or_default(),
            panes: parse_string_map(&row.panes, "device_tree_order.panes").unwrap_or_default(),
        })
    }

    pub async fn set_window_order(
        &self,
        device_id: &str,
        window_ids: &[String],
    ) -> RepositoryResult<()> {
        device_tree_order::Entity::insert(device_tree_order::ActiveModel {
            device_id: Set(device_id.to_owned()),
            windows: Set(json_string_list(window_ids)),
            panes: Set("{}".to_owned()),
            updated_at: Set(now_iso()),
        })
        .on_conflict(
            OnConflict::column(device_tree_order::Column::DeviceId)
                .update_columns([
                    device_tree_order::Column::Windows,
                    device_tree_order::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn set_pane_order(
        &self,
        device_id: &str,
        window_id: &str,
        pane_ids: &[String],
    ) -> RepositoryResult<()> {
        let transaction = self.database.begin().await?;
        let result = async {
            let current = device_tree_order::Entity::find_by_id(device_id.to_owned())
                .one(transaction.orm())
                .await?;
            let (windows, mut panes) = match current {
                Some(row) => (
                    parse_string_list(&row.windows, "device_tree_order.windows")
                        .unwrap_or_default(),
                    parse_string_map(&row.panes, "device_tree_order.panes").unwrap_or_default(),
                ),
                None => (Vec::new(), BTreeMap::new()),
            };
            panes.insert(window_id.to_owned(), pane_ids.to_vec());
            device_tree_order::Entity::insert(device_tree_order::ActiveModel {
                device_id: Set(device_id.to_owned()),
                windows: Set(json_string_list(&windows)),
                panes: Set(json_string_map(&panes)),
                updated_at: Set(now_iso()),
            })
            .on_conflict(
                OnConflict::column(device_tree_order::Column::DeviceId)
                    .update_columns([
                        device_tree_order::Column::Panes,
                        device_tree_order::Column::UpdatedAt,
                    ])
                    .to_owned(),
            )
            .exec_without_returning(transaction.orm())
            .await?;
            RepositoryResult::Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn get_device_runtime_status(
        &self,
        device_id: &str,
    ) -> RepositoryResult<device_runtime_status::Model> {
        Ok(
            device_runtime_status::Entity::find_by_id(device_id.to_owned())
                .one(self.database.orm())
                .await?
                .unwrap_or_else(|| device_runtime_status::Model {
                    device_id: device_id.to_owned(),
                    last_seen_at: None,
                    tmux_available: 0,
                    last_error: None,
                    last_error_type: None,
                }),
        )
    }

    pub async fn update_device_runtime_status(
        &self,
        device_id: &str,
        updates: DeviceRuntimeStatusUpdate,
    ) -> RepositoryResult<()> {
        let mut model = <device_runtime_status::ActiveModel as Default>::default();
        let mut changed = false;
        if let Some(value) = updates.last_seen_at {
            model.last_seen_at = Set(value);
            changed = true;
        }
        if let Some(value) = updates.tmux_available {
            model.tmux_available = Set(bool_value(value));
            changed = true;
        }
        if let Some(value) = updates.last_error {
            model.last_error = Set(value);
            changed = true;
        }
        if let Some(value) = updates.last_error_type {
            model.last_error_type = Set(value);
            changed = true;
        }
        if changed {
            device_runtime_status::Entity::update_many()
                .set(model)
                .filter(device_runtime_status::Column::DeviceId.eq(device_id))
                .exec(self.database.orm())
                .await?;
        }
        Ok(())
    }

    pub async fn get_site_settings(
        &self,
        defaults: &RepositorySiteSettingsDefaults,
    ) -> RepositoryResult<site_settings::Model> {
        if let Some(mut model) = site_settings::Entity::find_by_id(1)
            .one(self.database.orm())
            .await?
        {
            model.language = normalize_locale(&model.language);
            return Ok(model);
        }
        self.ensure_site_settings_initialized(defaults).await?;
        let mut model = site_settings::Entity::find_by_id(1)
            .one(self.database.orm())
            .await?
            .ok_or(RepositoryError::NotInitialized("site_settings"))?;
        model.language = normalize_locale(&model.language);
        Ok(model)
    }

    pub async fn update_site_settings(
        &self,
        defaults: &RepositorySiteSettingsDefaults,
        updates: SiteSettingsUpdate,
    ) -> RepositoryResult<site_settings::Model> {
        self.ensure_site_settings_initialized(defaults).await?;
        let transaction = self.database.begin().await?;
        let result = async {
            let mut current = site_settings::Entity::find_by_id(1)
                .one(transaction.orm())
                .await?
                .ok_or(RepositoryError::NotInitialized("site_settings"))?;
            current.language = normalize_locale(&current.language);
            let next = site_settings::Model {
                id: 1,
                site_name: updates.site_name.unwrap_or(current.site_name),
                site_url: updates.site_url.unwrap_or(current.site_url),
                bell_throttle_seconds: updates
                    .bell_throttle_seconds
                    .unwrap_or(current.bell_throttle_seconds),
                notification_throttle_seconds: updates
                    .notification_throttle_seconds
                    .unwrap_or(current.notification_throttle_seconds),
                enable_browser_notification_toast: updates
                    .enable_browser_notification_toast
                    .map(bool_value)
                    .unwrap_or(current.enable_browser_notification_toast),
                enable_notification_push: updates
                    .enable_notification_push
                    .map(bool_value)
                    .unwrap_or(current.enable_notification_push),
                enable_bell_push: updates
                    .enable_bell_push
                    .map(bool_value)
                    .unwrap_or(current.enable_bell_push),
                enable_bell_sound: updates
                    .enable_bell_sound
                    .map(bool_value)
                    .unwrap_or(current.enable_bell_sound),
                ssh_reconnect_max_retries: updates
                    .ssh_reconnect_max_retries
                    .unwrap_or(current.ssh_reconnect_max_retries),
                ssh_reconnect_delay_seconds: updates
                    .ssh_reconnect_delay_seconds
                    .unwrap_or(current.ssh_reconnect_delay_seconds),
                language: updates
                    .language
                    .filter(|value| !value.is_empty())
                    .map(|value| normalize_locale(&value))
                    .unwrap_or(current.language),
                theme: updates.theme.unwrap_or(current.theme),
                disabled_notification_channels: updates
                    .disabled_notification_channels
                    .map(|values| json_string_list(&values))
                    .unwrap_or(current.disabled_notification_channels),
                updated_at: now_iso(),
            };
            site_settings::Entity::update(site_settings::ActiveModel {
                id: Set(1),
                site_name: Set(next.site_name.clone()),
                site_url: Set(next.site_url.clone()),
                bell_throttle_seconds: Set(next.bell_throttle_seconds),
                notification_throttle_seconds: Set(next.notification_throttle_seconds),
                enable_browser_notification_toast: Set(next.enable_browser_notification_toast),
                enable_notification_push: Set(next.enable_notification_push),
                enable_bell_push: Set(next.enable_bell_push),
                enable_bell_sound: Set(next.enable_bell_sound),
                ssh_reconnect_max_retries: Set(next.ssh_reconnect_max_retries),
                ssh_reconnect_delay_seconds: Set(next.ssh_reconnect_delay_seconds),
                language: Set(next.language.clone()),
                theme: Set(next.theme.clone()),
                disabled_notification_channels: Set(next.disabled_notification_channels.clone()),
                updated_at: Set(next.updated_at.clone()),
            })
            .exec(transaction.orm())
            .await?;
            RepositoryResult::Ok(next)
        }
        .await;
        let next = match result {
            Ok(next) => next,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(next)
    }

    pub async fn ensure_terminal_shortcut_settings_initialized(
        &self,
        default_items: &Json,
    ) -> RepositoryResult<()> {
        terminal_shortcut_settings::Entity::insert(terminal_shortcut_settings::ActiveModel {
            id: Set(1),
            items: Set(default_items.to_string()),
            use_icons: Set(0),
            updated_at: Set(now_iso()),
        })
        .on_conflict(
            OnConflict::column(terminal_shortcut_settings::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_terminal_shortcut_settings(
        &self,
        default_items: &Json,
    ) -> RepositoryResult<TerminalShortcutSettingsRecord> {
        let row = match terminal_shortcut_settings::Entity::find_by_id(1)
            .one(self.database.orm())
            .await?
        {
            Some(row) => row,
            None => {
                self.ensure_terminal_shortcut_settings_initialized(default_items)
                    .await?;
                terminal_shortcut_settings::Entity::find_by_id(1)
                    .one(self.database.orm())
                    .await?
                    .ok_or(RepositoryError::NotInitialized(
                        "terminal_shortcut_settings",
                    ))?
            }
        };
        let items = row
            .items
            .parse::<Json>()
            .ok()
            .filter(Json::is_array)
            .unwrap_or_else(|| default_items.clone());
        Ok(TerminalShortcutSettingsRecord {
            items,
            use_icons: row.use_icons != 0,
            updated_at: row.updated_at,
        })
    }

    pub async fn update_terminal_shortcut_settings(
        &self,
        default_items: &Json,
        items: Json,
        use_icons: bool,
    ) -> RepositoryResult<TerminalShortcutSettingsRecord> {
        self.ensure_terminal_shortcut_settings_initialized(default_items)
            .await?;
        let next = TerminalShortcutSettingsRecord {
            items,
            use_icons,
            updated_at: now_iso(),
        };
        terminal_shortcut_settings::Entity::update(terminal_shortcut_settings::ActiveModel {
            id: Set(1),
            items: Set(next.items.to_string()),
            use_icons: Set(bool_value(next.use_icons)),
            updated_at: Set(next.updated_at.clone()),
        })
        .exec(self.database.orm())
        .await?;
        Ok(next)
    }

    pub async fn create_webhook_endpoint(
        &self,
        endpoint: webhook_endpoints::Model,
    ) -> RepositoryResult<()> {
        webhook_endpoints::Entity::insert(webhook_endpoints::ActiveModel {
            id: Set(endpoint.id),
            enabled: Set(endpoint.enabled),
            url: Set(endpoint.url),
            secret: Set(endpoint.secret),
            event_mask: Set(endpoint.event_mask),
            created_at: Set(endpoint.created_at),
            updated_at: Set(endpoint.updated_at),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_all_webhook_endpoints(
        &self,
    ) -> RepositoryResult<Vec<webhook_endpoints::Model>> {
        Ok(webhook_endpoints::Entity::find()
            .order_by_desc(webhook_endpoints::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn delete_webhook_endpoint(&self, id: &str) -> RepositoryResult<()> {
        webhook_endpoints::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }
}

impl Repository {
    pub async fn create_telegram_bot(&self, bot: telegram_bots::Model) -> RepositoryResult<()> {
        telegram_bots::Entity::insert(telegram_bots::ActiveModel {
            id: Set(bot.id),
            name: Set(bot.name),
            token_enc: Set(bot.token_enc),
            enabled: Set(bot.enabled),
            allow_auth_requests: Set(bot.allow_auth_requests),
            last_update_id: Set(bot.last_update_id),
            created_at: Set(bot.created_at),
            updated_at: Set(bot.updated_at),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_telegram_bot_by_id(
        &self,
        bot_id: &str,
    ) -> RepositoryResult<Option<telegram_bots::Model>> {
        Ok(telegram_bots::Entity::find_by_id(bot_id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_telegram_bots(&self) -> RepositoryResult<Vec<telegram_bots::Model>> {
        Ok(telegram_bots::Entity::find()
            .order_by_desc(telegram_bots::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_telegram_bots_with_stats(&self) -> RepositoryResult<Vec<TelegramBotStats>> {
        let bots = self.get_all_telegram_bots().await?;
        let mut counters = BTreeMap::<String, (u64, u64)>::new();
        for chat in telegram_bot_chats::Entity::find()
            .all(self.database.orm())
            .await?
        {
            let counter = counters.entry(chat.bot_id).or_default();
            if chat.status == "pending" {
                counter.0 += 1;
            }
            if chat.status == "authorized" {
                counter.1 += 1;
            }
        }
        Ok(bots
            .into_iter()
            .map(|bot| {
                let (pending_count, authorized_count) =
                    counters.get(&bot.id).copied().unwrap_or_default();
                TelegramBotStats {
                    id: bot.id,
                    name: bot.name,
                    enabled: bot.enabled != 0,
                    allow_auth_requests: bot.allow_auth_requests != 0,
                    created_at: bot.created_at,
                    updated_at: bot.updated_at,
                    pending_count,
                    authorized_count,
                }
            })
            .collect())
    }

    pub async fn update_telegram_bot(
        &self,
        bot_id: &str,
        updates: TelegramBotUpdate,
    ) -> RepositoryResult<Option<telegram_bots::Model>> {
        let mut model = telegram_bots::ActiveModel {
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.name {
            model.name = Set(value);
        }
        if let Some(value) = updates.token_enc {
            model.token_enc = Set(value);
        }
        if let Some(value) = updates.enabled {
            model.enabled = Set(bool_value(value));
        }
        if let Some(value) = updates.allow_auth_requests {
            model.allow_auth_requests = Set(bool_value(value));
        }
        if let Some(value) = updates.last_update_id {
            model.last_update_id = Set(value);
        }
        telegram_bots::Entity::update_many()
            .set(model)
            .filter(telegram_bots::Column::Id.eq(bot_id))
            .exec(self.database.orm())
            .await?;
        self.get_telegram_bot_by_id(bot_id).await
    }

    pub async fn delete_telegram_bot(&self, bot_id: &str) -> RepositoryResult<()> {
        telegram_bots::Entity::delete_by_id(bot_id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn get_telegram_chat_by_bot_and_chat_id(
        &self,
        bot_id: &str,
        chat_id: &str,
    ) -> RepositoryResult<Option<telegram_bot_chats::Model>> {
        Ok(telegram_bot_chats::Entity::find()
            .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
            .filter(telegram_bot_chats::Column::ChatId.eq(chat_id))
            .one(self.database.orm())
            .await?)
    }

    pub async fn create_or_update_pending_telegram_chat(
        &self,
        input: CreatePendingTelegramChatInput,
    ) -> RepositoryResult<telegram_bot_chats::Model> {
        let transaction = self.database.begin().await?;
        let result = async {
            let existing = telegram_bot_chats::Entity::find()
                .filter(telegram_bot_chats::Column::BotId.eq(&input.bot_id))
                .filter(telegram_bot_chats::Column::ChatId.eq(&input.chat_id))
                .one(transaction.orm())
                .await?;
            if existing.is_none() {
                let rows = telegram_bot_chats::Entity::find()
                    .filter(telegram_bot_chats::Column::BotId.eq(&input.bot_id))
                    .select_only()
                    .column(telegram_bot_chats::Column::Id)
                    .limit(TELEGRAM_CHAT_CAP)
                    .into_tuple::<String>()
                    .all(transaction.orm())
                    .await?;
                if rows.len() as u64 >= TELEGRAM_CHAT_CAP {
                    return Err(RepositoryError::LimitExceeded {
                        resource: "telegram chats per bot",
                        limit: TELEGRAM_CHAT_CAP,
                    });
                }
            }
            let now = now_iso();
            match existing {
                None => {
                    telegram_bot_chats::Entity::insert(telegram_bot_chats::ActiveModel {
                        id: Set(new_id()),
                        bot_id: Set(input.bot_id.clone()),
                        chat_id: Set(input.chat_id.clone()),
                        chat_type: Set(input.chat_type),
                        display_name: Set(input.display_name),
                        status: Set("pending".to_owned()),
                        applied_at: Set(input.applied_at),
                        authorized_at: Set(None),
                        updated_at: Set(now),
                    })
                    .exec_without_returning(transaction.orm())
                    .await?;
                }
                Some(existing) if existing.status == "authorized" => {
                    telegram_bot_chats::Entity::update_many()
                        .set(telegram_bot_chats::ActiveModel {
                            chat_type: Set(input.chat_type),
                            display_name: Set(input.display_name),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(telegram_bot_chats::Column::Id.eq(existing.id))
                        .exec(transaction.orm())
                        .await?;
                }
                Some(existing) => {
                    telegram_bot_chats::Entity::update_many()
                        .set(telegram_bot_chats::ActiveModel {
                            chat_type: Set(input.chat_type),
                            display_name: Set(input.display_name),
                            applied_at: Set(input.applied_at),
                            status: Set("pending".to_owned()),
                            updated_at: Set(now),
                            ..Default::default()
                        })
                        .filter(telegram_bot_chats::Column::Id.eq(existing.id))
                        .exec(transaction.orm())
                        .await?;
                }
            }
            telegram_bot_chats::Entity::find()
                .filter(telegram_bot_chats::Column::BotId.eq(&input.bot_id))
                .filter(telegram_bot_chats::Column::ChatId.eq(&input.chat_id))
                .one(transaction.orm())
                .await?
                .ok_or(RepositoryError::MissingAfterWrite("telegram chat"))
        }
        .await;
        let chat = match result {
            Ok(chat) => chat,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(chat)
    }

    pub async fn list_telegram_chats_by_bot(
        &self,
        bot_id: &str,
    ) -> RepositoryResult<Vec<telegram_bot_chats::Model>> {
        Ok(telegram_bot_chats::Entity::find()
            .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
            .order_by_desc(telegram_bot_chats::Column::AppliedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn list_authorized_telegram_chats_by_bot(
        &self,
        bot_id: &str,
    ) -> RepositoryResult<Vec<telegram_bot_chats::Model>> {
        Ok(telegram_bot_chats::Entity::find()
            .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
            .filter(telegram_bot_chats::Column::Status.eq("authorized"))
            .order_by_desc(telegram_bot_chats::Column::AuthorizedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn approve_telegram_chat(
        &self,
        bot_id: &str,
        chat_id: &str,
    ) -> RepositoryResult<Option<telegram_bot_chats::Model>> {
        let transaction = self.database.begin().await?;
        let result = async {
            let Some(existing) = telegram_bot_chats::Entity::find()
                .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
                .filter(telegram_bot_chats::Column::ChatId.eq(chat_id))
                .one(transaction.orm())
                .await?
            else {
                return RepositoryResult::Ok(None);
            };
            let now = now_iso();
            telegram_bot_chats::Entity::update_many()
                .set(telegram_bot_chats::ActiveModel {
                    status: Set("authorized".to_owned()),
                    authorized_at: Set(Some(now.clone())),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .filter(telegram_bot_chats::Column::Id.eq(existing.id))
                .exec(transaction.orm())
                .await?;
            Ok(telegram_bot_chats::Entity::find()
                .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
                .filter(telegram_bot_chats::Column::ChatId.eq(chat_id))
                .one(transaction.orm())
                .await?)
        }
        .await;
        let chat = match result {
            Ok(chat) => chat,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(chat)
    }

    pub async fn delete_telegram_chat(&self, bot_id: &str, chat_id: &str) -> RepositoryResult<()> {
        telegram_bot_chats::Entity::delete_many()
            .filter(telegram_bot_chats::Column::BotId.eq(bot_id))
            .filter(telegram_bot_chats::Column::ChatId.eq(chat_id))
            .exec(self.database.orm())
            .await?;
        Ok(())
    }
}

impl Repository {
    pub async fn create_weixin_account(
        &self,
        account: weixin_accounts::Model,
    ) -> RepositoryResult<()> {
        weixin_accounts::Entity::insert(weixin_accounts::ActiveModel {
            id: Set(account.id),
            name: Set(account.name),
            enabled: Set(account.enabled),
            allow_auth_requests: Set(account.allow_auth_requests),
            weixin_uin: Set(account.weixin_uin),
            bot_token_enc: Set(account.bot_token_enc),
            base_url: Set(account.base_url),
            sync_buf: Set(account.sync_buf),
            created_at: Set(account.created_at),
            updated_at: Set(account.updated_at),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_weixin_account_by_id(
        &self,
        account_id: &str,
    ) -> RepositoryResult<Option<weixin_accounts::Model>> {
        Ok(weixin_accounts::Entity::find_by_id(account_id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_weixin_accounts(&self) -> RepositoryResult<Vec<weixin_accounts::Model>> {
        Ok(weixin_accounts::Entity::find()
            .order_by_desc(weixin_accounts::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_weixin_accounts_with_stats(
        &self,
    ) -> RepositoryResult<Vec<WeixinAccountStats>> {
        let accounts = self.get_all_weixin_accounts().await?;
        let mut counters = BTreeMap::<String, (u64, u64, u64)>::new();
        for user in weixin_account_users::Entity::find()
            .all(self.database.orm())
            .await?
        {
            let counter = counters.entry(user.account_id).or_default();
            if user.status == "pending" {
                counter.0 += 1;
            }
            if user.status == "authorized" {
                counter.1 += 1;
                if user.needs_reactivation != 0 {
                    counter.2 += 1;
                }
            }
        }
        Ok(accounts
            .into_iter()
            .map(|account| {
                let (pending_count, authorized_count, needs_reactivation_count) =
                    counters.get(&account.id).copied().unwrap_or_default();
                WeixinAccountStats {
                    id: account.id,
                    name: account.name,
                    enabled: account.enabled != 0,
                    allow_auth_requests: account.allow_auth_requests != 0,
                    logged_in: account.bot_token_enc.is_some(),
                    created_at: account.created_at,
                    updated_at: account.updated_at,
                    pending_count,
                    authorized_count,
                    needs_reactivation_count,
                }
            })
            .collect())
    }

    pub async fn update_weixin_account(
        &self,
        account_id: &str,
        updates: WeixinAccountUpdate,
    ) -> RepositoryResult<Option<weixin_accounts::Model>> {
        let mut model = weixin_accounts::ActiveModel {
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.name {
            model.name = Set(value);
        }
        if let Some(value) = updates.enabled {
            model.enabled = Set(bool_value(value));
        }
        if let Some(value) = updates.allow_auth_requests {
            model.allow_auth_requests = Set(bool_value(value));
        }
        if let Some(value) = updates.weixin_uin {
            model.weixin_uin = Set(value);
        }
        if let Some(value) = updates.bot_token_enc {
            model.bot_token_enc = Set(value);
        }
        if let Some(value) = updates.base_url {
            model.base_url = Set(value);
        }
        if let Some(value) = updates.sync_buf {
            model.sync_buf = Set(value);
        }
        weixin_accounts::Entity::update_many()
            .set(model)
            .filter(weixin_accounts::Column::Id.eq(account_id))
            .exec(self.database.orm())
            .await?;
        self.get_weixin_account_by_id(account_id).await
    }

    pub async fn delete_weixin_account(&self, account_id: &str) -> RepositoryResult<()> {
        weixin_accounts::Entity::delete_by_id(account_id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn get_weixin_user_by_account_and_user_id(
        &self,
        account_id: &str,
        user_id: &str,
    ) -> RepositoryResult<Option<weixin_account_users::Model>> {
        Ok(weixin_account_users::Entity::find()
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .filter(weixin_account_users::Column::UserId.eq(user_id))
            .one(self.database.orm())
            .await?)
    }

    pub async fn upsert_weixin_user_on_inbound(
        &self,
        input: UpsertWeixinUserInput,
    ) -> RepositoryResult<Option<weixin_account_users::Model>> {
        let transaction = self.database.begin().await?;
        let result = async {
            let existing = weixin_account_users::Entity::find()
                .filter(weixin_account_users::Column::AccountId.eq(&input.account_id))
                .filter(weixin_account_users::Column::UserId.eq(&input.user_id))
                .one(transaction.orm())
                .await?;
            if let Some(existing) = existing {
                let mut model = weixin_account_users::ActiveModel {
                    display_name: Set(input.display_name),
                    last_inbound_at: Set(Some(input.at.clone())),
                    needs_reactivation: Set(0),
                    updated_at: Set(input.at),
                    ..Default::default()
                };
                if let Some(context_token) = input.context_token {
                    model.last_context_token = Set(Some(context_token));
                }
                weixin_account_users::Entity::update_many()
                    .set(model)
                    .filter(weixin_account_users::Column::Id.eq(existing.id))
                    .exec(transaction.orm())
                    .await?;
            } else {
                if !input.allow_auth_requests {
                    return RepositoryResult::Ok(None);
                }
                let rows = weixin_account_users::Entity::find()
                    .filter(weixin_account_users::Column::AccountId.eq(&input.account_id))
                    .select_only()
                    .column(weixin_account_users::Column::Id)
                    .limit(WEIXIN_USER_CAP)
                    .into_tuple::<String>()
                    .all(transaction.orm())
                    .await?;
                if rows.len() as u64 >= WEIXIN_USER_CAP {
                    return Err(RepositoryError::LimitExceeded {
                        resource: "weixin users per account",
                        limit: WEIXIN_USER_CAP,
                    });
                }
                weixin_account_users::Entity::insert(weixin_account_users::ActiveModel {
                    id: Set(new_id()),
                    account_id: Set(input.account_id.clone()),
                    user_id: Set(input.user_id.clone()),
                    display_name: Set(input.display_name),
                    status: Set("pending".to_owned()),
                    last_context_token: Set(input.context_token),
                    last_inbound_at: Set(Some(input.at.clone())),
                    needs_reactivation: Set(0),
                    applied_at: Set(input.at.clone()),
                    authorized_at: Set(None),
                    updated_at: Set(input.at),
                })
                .exec_without_returning(transaction.orm())
                .await?;
            }
            Ok(weixin_account_users::Entity::find()
                .filter(weixin_account_users::Column::AccountId.eq(&input.account_id))
                .filter(weixin_account_users::Column::UserId.eq(&input.user_id))
                .one(transaction.orm())
                .await?)
        }
        .await;
        let user = match result {
            Ok(user) => user,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(user)
    }

    pub async fn list_weixin_users_by_account(
        &self,
        account_id: &str,
    ) -> RepositoryResult<Vec<weixin_account_users::Model>> {
        Ok(weixin_account_users::Entity::find()
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .order_by_desc(weixin_account_users::Column::AppliedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn list_authorized_weixin_users_by_account(
        &self,
        account_id: &str,
    ) -> RepositoryResult<Vec<weixin_account_users::Model>> {
        Ok(weixin_account_users::Entity::find()
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .filter(weixin_account_users::Column::Status.eq("authorized"))
            .order_by_desc(weixin_account_users::Column::AuthorizedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_weixin_user_context_tokens(
        &self,
        account_id: &str,
    ) -> RepositoryResult<Vec<WeixinContextToken>> {
        Ok(weixin_account_users::Entity::find()
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .all(self.database.orm())
            .await?
            .into_iter()
            .filter_map(|user| {
                user.last_context_token
                    .map(|context_token| WeixinContextToken {
                        user_id: user.user_id,
                        context_token,
                    })
            })
            .collect())
    }

    pub async fn approve_weixin_user(
        &self,
        account_id: &str,
        user_id: &str,
    ) -> RepositoryResult<Option<weixin_account_users::Model>> {
        let transaction = self.database.begin().await?;
        let result = async {
            let Some(existing) = weixin_account_users::Entity::find()
                .filter(weixin_account_users::Column::AccountId.eq(account_id))
                .filter(weixin_account_users::Column::UserId.eq(user_id))
                .one(transaction.orm())
                .await?
            else {
                return RepositoryResult::Ok(None);
            };
            let now = now_iso();
            weixin_account_users::Entity::update_many()
                .set(weixin_account_users::ActiveModel {
                    status: Set("authorized".to_owned()),
                    authorized_at: Set(Some(now.clone())),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .filter(weixin_account_users::Column::Id.eq(existing.id))
                .exec(transaction.orm())
                .await?;
            Ok(weixin_account_users::Entity::find()
                .filter(weixin_account_users::Column::AccountId.eq(account_id))
                .filter(weixin_account_users::Column::UserId.eq(user_id))
                .one(transaction.orm())
                .await?)
        }
        .await;
        let user = match result {
            Ok(user) => user,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(user)
    }

    pub async fn delete_weixin_user(
        &self,
        account_id: &str,
        user_id: &str,
    ) -> RepositoryResult<()> {
        weixin_account_users::Entity::delete_many()
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .filter(weixin_account_users::Column::UserId.eq(user_id))
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn set_weixin_user_needs_reactivation(
        &self,
        account_id: &str,
        user_id: &str,
        value: bool,
    ) -> RepositoryResult<()> {
        weixin_account_users::Entity::update_many()
            .set(weixin_account_users::ActiveModel {
                needs_reactivation: Set(bool_value(value)),
                updated_at: Set(now_iso()),
                ..Default::default()
            })
            .filter(weixin_account_users::Column::AccountId.eq(account_id))
            .filter(weixin_account_users::Column::UserId.eq(user_id))
            .exec(self.database.orm())
            .await?;
        Ok(())
    }
}
