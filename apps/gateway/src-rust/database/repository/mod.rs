mod agent;
mod core;
mod file_roots;
mod llm;
mod watch;

use std::collections::BTreeMap;
use std::time::SystemTime;

use sea_orm::entity::prelude::{ChronoDateTimeUtc, Json, Uuid};
use tmex_db::{Database, DbTransaction};

pub use agent::{
    AgentConfirmationDecision, AgentSessionUpdate, AgentSettingsUpdate,
    CreateAgentConfirmationInput, CreateAgentSessionInput,
};
pub use core::{
    CreatePendingTelegramChatInput, DeviceRuntimeStatusUpdate, DeviceTreeOrderRecord,
    RepositorySiteSettingsDefaults, SiteSettingsUpdate, TelegramBotStats, TelegramBotUpdate,
    TerminalShortcutSettingsRecord, UpdateDevice, UpsertWeixinUserInput, WeixinAccountStats,
    WeixinAccountUpdate, WeixinContextToken,
};
pub use file_roots::{CreateFileRootInput, UpdateFileRootInput};
pub use llm::{
    compute_provider_models, CreateLlmProviderInput, LlmProviderUpdate, ProviderModelInfo,
    ProviderModelSource, ProviderModels,
};
pub use watch::{CreateWatchRuleInput, WatchRuleStateUpdate, WatchRuleUpdate};

pub const DEFAULT_LOCAL_DEVICE_SEED_KEY: &str = "default_local_device_seeded";

#[derive(Clone)]
pub struct Repository {
    database: Database,
}

impl Repository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub fn into_database(self) -> Database {
        self.database
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    #[error(transparent)]
    Database(#[from] tmex_db::DbError),
    #[error(transparent)]
    Orm(#[from] sea_orm::DbErr),
    #[error("{0} is not initialized")]
    NotInitialized(&'static str),
    #[error("failed to read {0} after writing it")]
    MissingAfterWrite(&'static str),
    #[error("invalid JSON in {field}: {message}")]
    InvalidJson {
        field: &'static str,
        message: String,
    },
    #[error("{resource} limit of {limit} has been reached")]
    LimitExceeded { resource: &'static str, limit: u64 },
    #[error("database operation failed: {operation}; rollback also failed: {rollback}")]
    Rollback {
        operation: String,
        #[source]
        rollback: tmex_db::DbError,
    },
}

pub type RepositoryResult<T> = Result<T, RepositoryError>;

pub(crate) fn now_iso() -> String {
    let now: ChronoDateTimeUtc = SystemTime::now().into();
    now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub(crate) fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub(crate) fn bool_value(value: bool) -> i64 {
    i64::from(value)
}

pub(crate) fn json_string_list(values: &[String]) -> String {
    Json::Array(values.iter().cloned().map(Json::String).collect()).to_string()
}

pub(crate) fn parse_string_list(value: &str, field: &'static str) -> RepositoryResult<Vec<String>> {
    let value = value
        .parse::<Json>()
        .map_err(|error| RepositoryError::InvalidJson {
            field,
            message: error.to_string(),
        })?;
    match value {
        Json::Array(values) => values
            .into_iter()
            .map(|value| match value {
                Json::String(value) => Ok(value),
                other => Err(RepositoryError::InvalidJson {
                    field,
                    message: format!("expected string array, found {other}"),
                }),
            })
            .collect(),
        other => Err(RepositoryError::InvalidJson {
            field,
            message: format!("expected array, found {other}"),
        }),
    }
}

pub(crate) fn json_string_map(values: &BTreeMap<String, Vec<String>>) -> String {
    Json::Object(
        values
            .iter()
            .map(|(key, values)| {
                (
                    key.clone(),
                    Json::Array(values.iter().cloned().map(Json::String).collect()),
                )
            })
            .collect(),
    )
    .to_string()
}

pub(crate) fn parse_string_map(
    value: &str,
    field: &'static str,
) -> RepositoryResult<BTreeMap<String, Vec<String>>> {
    let value = value
        .parse::<Json>()
        .map_err(|error| RepositoryError::InvalidJson {
            field,
            message: error.to_string(),
        })?;
    let Json::Object(values) = value else {
        return Err(RepositoryError::InvalidJson {
            field,
            message: "expected object".to_owned(),
        });
    };
    values
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                Json::Array(values) => values
                    .into_iter()
                    .map(|value| match value {
                        Json::String(value) => Ok(value),
                        other => Err(RepositoryError::InvalidJson {
                            field,
                            message: format!("expected string array, found {other}"),
                        }),
                    })
                    .collect::<RepositoryResult<Vec<_>>>()?,
                other => {
                    return Err(RepositoryError::InvalidJson {
                        field,
                        message: format!("expected string array, found {other}"),
                    });
                }
            };
            Ok((key, value))
        })
        .collect()
}

pub(crate) async fn rollback<T>(
    transaction: DbTransaction,
    operation: RepositoryError,
) -> RepositoryResult<T> {
    match transaction.rollback().await {
        Ok(()) => Err(operation),
        Err(rollback) => Err(RepositoryError::Rollback {
            operation: operation.to_string(),
            rollback,
        }),
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{DbBackend, Statement};
    use tmex_db::DbConfig;

    use crate::crypto::MasterKey;
    use crate::database::DatabaseBootstrap;
    use crate::entity::{devices, telegram_bots, weixin_accounts};

    use super::*;

    async fn test_repository() -> Repository {
        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .expect("bootstrap repository database");
        Repository::new(database)
    }

    fn device(id: &str) -> devices::Model {
        let now = now_iso();
        devices::Model {
            id: id.to_owned(),
            name: "local".to_owned(),
            r#type: "local".to_owned(),
            host: None,
            port: None,
            username: None,
            ssh_config_ref: None,
            session: None,
            auth_mode: "auto".to_owned(),
            password_enc: None,
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: None,
            sort_order: 99,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn site_defaults() -> RepositorySiteSettingsDefaults {
        RepositorySiteSettingsDefaults {
            site_name: "tmex".to_owned(),
            site_url: "http://localhost".to_owned(),
            bell_throttle_seconds: 5,
            notification_throttle_seconds: 5,
            ssh_reconnect_max_retries: 3,
            ssh_reconnect_delay_seconds: 1,
            language: "en_US".to_owned(),
        }
    }

    #[tokio::test]
    async fn seeds_the_default_local_device_only_once() {
        let repository = test_repository().await;

        repository
            .ensure_default_local_device_seeded("  gateway-host  ")
            .await
            .expect("seed default local device");

        let devices = repository.get_all_devices().await.expect("list devices");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "gateway-host");
        assert_eq!(devices[0].r#type, "local");
        assert_eq!(devices[0].port, Some(22));
        assert_eq!(devices[0].session.as_deref(), Some("tmex"));
        assert_eq!(devices[0].sort_order, 0);
        assert_eq!(
            repository
                .get_gateway_kv(DEFAULT_LOCAL_DEVICE_SEED_KEY)
                .await
                .expect("read seed marker")
                .as_deref(),
            Some("1")
        );
        let runtime = repository
            .get_device_runtime_status(&devices[0].id)
            .await
            .expect("read seeded runtime status");
        assert_eq!(runtime.tmux_available, 0);

        repository
            .delete_device(&devices[0].id)
            .await
            .expect("delete seeded device");
        repository
            .ensure_default_local_device_seeded("gateway-host")
            .await
            .expect("repeat seed");
        assert!(repository
            .get_all_devices()
            .await
            .expect("list devices after repeat seed")
            .is_empty());
    }

    #[tokio::test]
    async fn concurrent_fresh_seeds_create_only_one_default_local_device() {
        let repository = test_repository().await;
        let first = repository.clone();
        let second = repository.clone();
        let (left, right) = tokio::join!(
            first.ensure_default_local_device_seeded("seed-one"),
            second.ensure_default_local_device_seeded("seed-two"),
        );
        left.expect("first concurrent seed");
        right.expect("second concurrent seed");
        let devices = repository
            .get_all_devices()
            .await
            .expect("list devices after concurrent seed");
        assert_eq!(devices.len(), 1);
        assert!(devices[0].name == "seed-one" || devices[0].name == "seed-two");
        assert_eq!(
            repository
                .get_gateway_kv(DEFAULT_LOCAL_DEVICE_SEED_KEY)
                .await
                .expect("read seed marker")
                .as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn id_only_projections_handle_existing_rows_without_decoding_full_models() {
        const NOW: &str = "2026-08-12T12:00:00.000Z";

        let settings_repository = test_repository().await;
        settings_repository
            .ensure_site_settings_initialized(&RepositorySiteSettingsDefaults {
                site_name: "tmex".to_owned(),
                site_url: "http://localhost".to_owned(),
                bell_throttle_seconds: 5,
                notification_throttle_seconds: 5,
                ssh_reconnect_max_retries: 3,
                ssh_reconnect_delay_seconds: 1,
                language: "en_US".to_owned(),
            })
            .await
            .expect("seed historical site settings");
        settings_repository
            .ensure_default_local_device_seeded("gateway-host")
            .await
            .expect("existing site settings should suppress the default device seed");
        assert!(settings_repository
            .get_all_devices()
            .await
            .expect("list devices after historical settings")
            .is_empty());

        let device_repository = test_repository().await;
        device_repository
            .create_device(device("existing-device"))
            .await
            .expect("seed historical device");
        device_repository
            .ensure_default_local_device_seeded("gateway-host")
            .await
            .expect("existing device should suppress the default device seed");
        assert_eq!(
            device_repository
                .get_all_devices()
                .await
                .expect("list historical devices")
                .len(),
            1
        );

        let count_repository = test_repository().await;
        count_repository
            .create_telegram_bot(telegram_bots::Model {
                id: "bot".to_owned(),
                name: "bot".to_owned(),
                token_enc: "ciphertext".to_owned(),
                enabled: 1,
                allow_auth_requests: 1,
                last_update_id: None,
                created_at: NOW.to_owned(),
                updated_at: NOW.to_owned(),
            })
            .await
            .expect("seed Telegram bot");
        for chat_id in ["first-chat", "second-chat"] {
            count_repository
                .create_or_update_pending_telegram_chat(CreatePendingTelegramChatInput {
                    bot_id: "bot".to_owned(),
                    chat_id: chat_id.to_owned(),
                    chat_type: "private".to_owned(),
                    display_name: chat_id.to_owned(),
                    applied_at: NOW.to_owned(),
                })
                .await
                .expect("count existing Telegram chats before insert");
        }

        count_repository
            .create_weixin_account(weixin_accounts::Model {
                id: "account".to_owned(),
                name: "account".to_owned(),
                enabled: 1,
                allow_auth_requests: 1,
                weixin_uin: None,
                bot_token_enc: None,
                base_url: None,
                sync_buf: None,
                created_at: NOW.to_owned(),
                updated_at: NOW.to_owned(),
            })
            .await
            .expect("seed Weixin account");
        for user_id in ["first-user", "second-user"] {
            count_repository
                .upsert_weixin_user_on_inbound(UpsertWeixinUserInput {
                    account_id: "account".to_owned(),
                    user_id: user_id.to_owned(),
                    display_name: user_id.to_owned(),
                    context_token: Some(format!("context-{user_id}")),
                    allow_auth_requests: true,
                    at: NOW.to_owned(),
                })
                .await
                .expect("count existing Weixin users before insert");
        }
    }

    #[tokio::test]
    async fn rolls_back_device_and_runtime_status_as_one_write() {
        let repository = test_repository().await;
        repository
            .database()
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "CREATE TRIGGER reject_runtime_status BEFORE INSERT ON device_runtime_status \
                 WHEN NEW.device_id = 'rollback-device' BEGIN \
                 SELECT RAISE(ABORT, 'forced runtime status failure'); END",
            ))
            .await
            .expect("create failure trigger");

        repository
            .create_device(device("rollback-device"))
            .await
            .expect_err("runtime status failure must abort create_device");

        assert!(repository
            .get_device_by_id("rollback-device")
            .await
            .expect("query rolled-back device")
            .is_none());
    }

    #[tokio::test]
    async fn concurrent_read_modify_write_operations_preserve_disjoint_changes() {
        let repository = test_repository().await;
        repository
            .create_device(device("concurrent-device"))
            .await
            .expect("create device for concurrent updates");
        repository
            .set_window_order(
                "concurrent-device",
                &["@left".to_owned(), "@right".to_owned()],
            )
            .await
            .expect("initialize device tree order");

        let left_panes = vec!["%left".to_owned()];
        let right_panes = vec!["%right".to_owned()];
        let (left, right) = tokio::join!(
            repository.set_pane_order("concurrent-device", "@left", &left_panes),
            repository.set_pane_order("concurrent-device", "@right", &right_panes),
        );
        left.expect("update left pane order");
        right.expect("update right pane order");
        let tree = repository
            .get_device_tree_order("concurrent-device")
            .await
            .expect("read merged device tree order");
        assert_eq!(tree.panes.get("@left"), Some(&left_panes));
        assert_eq!(tree.panes.get("@right"), Some(&right_panes));

        let defaults = site_defaults();
        repository
            .ensure_site_settings_initialized(&defaults)
            .await
            .expect("initialize site settings");
        let (name, url) = tokio::join!(
            repository.update_site_settings(
                &defaults,
                SiteSettingsUpdate {
                    site_name: Some("concurrent-name".to_owned()),
                    ..Default::default()
                },
            ),
            repository.update_site_settings(
                &defaults,
                SiteSettingsUpdate {
                    site_url: Some("https://concurrent.invalid".to_owned()),
                    ..Default::default()
                },
            ),
        );
        name.expect("update site name");
        url.expect("update site URL");
        let settings = repository
            .get_site_settings(&defaults)
            .await
            .expect("read merged site settings");
        assert_eq!(settings.site_name, "concurrent-name");
        assert_eq!(settings.site_url, "https://concurrent.invalid");

        let root = repository
            .create_file_root(CreateFileRootInput {
                device_id: "concurrent-device".to_owned(),
                path: "/initial".to_owned(),
                enabled: Some(true),
            })
            .await
            .expect("create file root");
        let (path, enabled) = tokio::join!(
            repository.update_file_root(
                &root.id,
                UpdateFileRootInput {
                    path: Some("/updated".to_owned()),
                    ..Default::default()
                },
            ),
            repository.update_file_root(
                &root.id,
                UpdateFileRootInput {
                    enabled: Some(false),
                    ..Default::default()
                },
            ),
        );
        path.expect("update file root path");
        enabled.expect("update file root enabled state");
        let root = repository
            .get_file_root_by_id(&root.id)
            .await
            .expect("read merged file root")
            .expect("file root exists");
        assert_eq!(root.path, "/updated");
        assert_eq!(root.enabled, 0);

        let (first, second) = tokio::join!(
            repository.create_file_root(CreateFileRootInput {
                device_id: "concurrent-device".to_owned(),
                path: "/first".to_owned(),
                enabled: None,
            }),
            repository.create_file_root(CreateFileRootInput {
                device_id: "concurrent-device".to_owned(),
                path: "/second".to_owned(),
                enabled: None,
            }),
        );
        let first = first.expect("create first concurrent file root");
        let second = second.expect("create second concurrent file root");
        assert_ne!(first.sort_order, second.sort_order);

        const NOW: &str = "2026-08-12T12:00:00.000Z";
        repository
            .create_telegram_bot(telegram_bots::Model {
                id: "concurrent-bot".to_owned(),
                name: "concurrent bot".to_owned(),
                token_enc: "ciphertext".to_owned(),
                enabled: 1,
                allow_auth_requests: 1,
                last_update_id: None,
                created_at: NOW.to_owned(),
                updated_at: NOW.to_owned(),
            })
            .await
            .expect("create bot for concurrent chat cap");
        for index in 0..7 {
            repository
                .create_or_update_pending_telegram_chat(CreatePendingTelegramChatInput {
                    bot_id: "concurrent-bot".to_owned(),
                    chat_id: format!("existing-chat-{index}"),
                    chat_type: "private".to_owned(),
                    display_name: format!("existing chat {index}"),
                    applied_at: NOW.to_owned(),
                })
                .await
                .expect("seed Telegram chat below the cap");
        }
        let (first_chat, second_chat) = tokio::join!(
            repository.create_or_update_pending_telegram_chat(CreatePendingTelegramChatInput {
                bot_id: "concurrent-bot".to_owned(),
                chat_id: "concurrent-chat-1".to_owned(),
                chat_type: "private".to_owned(),
                display_name: "concurrent chat 1".to_owned(),
                applied_at: NOW.to_owned(),
            }),
            repository.create_or_update_pending_telegram_chat(CreatePendingTelegramChatInput {
                bot_id: "concurrent-bot".to_owned(),
                chat_id: "concurrent-chat-2".to_owned(),
                chat_type: "private".to_owned(),
                display_name: "concurrent chat 2".to_owned(),
                applied_at: NOW.to_owned(),
            }),
        );
        assert_eq!(
            usize::from(first_chat.is_ok()) + usize::from(second_chat.is_ok()),
            1
        );
        assert_eq!(
            repository
                .list_telegram_chats_by_bot("concurrent-bot")
                .await
                .expect("list capped Telegram chats")
                .len(),
            8
        );

        repository
            .create_weixin_account(weixin_accounts::Model {
                id: "concurrent-account".to_owned(),
                name: "concurrent account".to_owned(),
                enabled: 1,
                allow_auth_requests: 1,
                weixin_uin: None,
                bot_token_enc: None,
                base_url: None,
                sync_buf: None,
                created_at: NOW.to_owned(),
                updated_at: NOW.to_owned(),
            })
            .await
            .expect("create account for concurrent user cap");
        for index in 0..15 {
            repository
                .upsert_weixin_user_on_inbound(UpsertWeixinUserInput {
                    account_id: "concurrent-account".to_owned(),
                    user_id: format!("existing-user-{index}"),
                    display_name: format!("existing user {index}"),
                    context_token: None,
                    allow_auth_requests: true,
                    at: NOW.to_owned(),
                })
                .await
                .expect("seed Weixin user below the cap");
        }
        let (first_user, second_user) = tokio::join!(
            repository.upsert_weixin_user_on_inbound(UpsertWeixinUserInput {
                account_id: "concurrent-account".to_owned(),
                user_id: "concurrent-user-1".to_owned(),
                display_name: "concurrent user 1".to_owned(),
                context_token: None,
                allow_auth_requests: true,
                at: NOW.to_owned(),
            }),
            repository.upsert_weixin_user_on_inbound(UpsertWeixinUserInput {
                account_id: "concurrent-account".to_owned(),
                user_id: "concurrent-user-2".to_owned(),
                display_name: "concurrent user 2".to_owned(),
                context_token: None,
                allow_auth_requests: true,
                at: NOW.to_owned(),
            }),
        );
        assert_eq!(
            usize::from(first_user.is_ok()) + usize::from(second_user.is_ok()),
            1
        );
        assert_eq!(
            repository
                .list_weixin_users_by_account("concurrent-account")
                .await
                .expect("list capped Weixin users")
                .len(),
            16
        );
    }

    #[tokio::test]
    async fn preserves_legacy_ciphertext_without_reencoding() {
        const CIPHERTEXT: &str = "AAECAwQFBgcICQoL/KZWKi0YCkUn1uv65d4zIL8kmca2F/84jnWa";
        let repository = test_repository().await;

        let provider = repository
            .create_llm_provider(CreateLlmProviderInput {
                name: "legacy".to_owned(),
                protocol: "openai-chat".to_owned(),
                base_url: "https://example.invalid".to_owned(),
                api_key_enc: CIPHERTEXT.to_owned(),
                enabled: Some(true),
            })
            .await
            .expect("store legacy ciphertext");
        let stored = repository
            .get_llm_provider_by_id(&provider.id)
            .await
            .expect("read legacy provider")
            .expect("provider exists");

        assert_eq!(stored.api_key_enc, CIPHERTEXT);
        assert_eq!(
            MasterKey::development_default()
                .decrypt(&stored.api_key_enc)
                .expect("decrypt persisted TypeScript ciphertext"),
            "tmex-兼容"
        );
    }

    #[tokio::test]
    async fn draining_agent_queue_rolls_back_without_losing_user_input() {
        let repository = test_repository().await;
        let session = repository
            .create_agent_session(CreateAgentSessionInput {
                title: "queue rollback".to_owned(),
                device_id: None,
                pane_id: None,
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
            .expect("create agent session");
        repository
            .enqueue_agent_message(&session.id, "first")
            .await
            .expect("enqueue first message");
        repository
            .enqueue_agent_message(&session.id, "second")
            .await
            .expect("enqueue second message");
        repository
            .database()
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "CREATE TRIGGER reject_second_agent_message BEFORE INSERT ON agent_messages \
                 WHEN NEW.content LIKE '%second%' BEGIN \
                 SELECT RAISE(ABORT, 'forced agent message failure'); END",
            ))
            .await
            .expect("create failure trigger");

        repository
            .drain_queued_agent_messages(&session.id)
            .await
            .expect_err("message insert failure must abort queue drain");
        let queued = repository
            .list_queued_agent_messages(&session.id)
            .await
            .expect("read rolled-back queue");
        assert_eq!(
            queued
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(repository
            .list_agent_messages(&session.id, None)
            .await
            .expect("read rolled-back messages")
            .is_empty());

        repository
            .database()
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "DROP TRIGGER reject_second_agent_message",
            ))
            .await
            .expect("drop failure trigger");
        let messages = repository
            .drain_queued_agent_messages(&session.id)
            .await
            .expect("retry queue drain");
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            [0, 1]
        );
        assert!(repository
            .list_queued_agent_messages(&session.id)
            .await
            .expect("read drained queue")
            .is_empty());
    }
}
