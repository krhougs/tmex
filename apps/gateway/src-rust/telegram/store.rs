use async_trait::async_trait;

use crate::database::repository::{CreatePendingTelegramChatInput, Repository, TelegramBotUpdate};
use crate::entity::{telegram_bot_chats, telegram_bots};

use super::TelegramStoreError;

#[async_trait]
pub trait TelegramStore: Send + Sync {
    async fn all_bots(&self) -> Result<Vec<telegram_bots::Model>, TelegramStoreError>;
    async fn bot_by_id(
        &self,
        bot_id: &str,
    ) -> Result<Option<telegram_bots::Model>, TelegramStoreError>;
    async fn upsert_pending_chat(
        &self,
        input: CreatePendingTelegramChatInput,
    ) -> Result<telegram_bot_chats::Model, TelegramStoreError>;
    async fn authorized_chats(
        &self,
        bot_id: &str,
    ) -> Result<Vec<telegram_bot_chats::Model>, TelegramStoreError>;
    async fn persist_next_offset(
        &self,
        bot_id: &str,
        offset: i64,
    ) -> Result<(), TelegramStoreError>;
}

fn store_error(error: impl std::fmt::Display) -> TelegramStoreError {
    TelegramStoreError::new(error.to_string())
}

#[async_trait]
impl TelegramStore for Repository {
    async fn all_bots(&self) -> Result<Vec<telegram_bots::Model>, TelegramStoreError> {
        self.get_all_telegram_bots().await.map_err(store_error)
    }

    async fn bot_by_id(
        &self,
        bot_id: &str,
    ) -> Result<Option<telegram_bots::Model>, TelegramStoreError> {
        self.get_telegram_bot_by_id(bot_id)
            .await
            .map_err(store_error)
    }

    async fn upsert_pending_chat(
        &self,
        input: CreatePendingTelegramChatInput,
    ) -> Result<telegram_bot_chats::Model, TelegramStoreError> {
        self.create_or_update_pending_telegram_chat(input)
            .await
            .map_err(store_error)
    }

    async fn authorized_chats(
        &self,
        bot_id: &str,
    ) -> Result<Vec<telegram_bot_chats::Model>, TelegramStoreError> {
        self.list_authorized_telegram_chats_by_bot(bot_id)
            .await
            .map_err(store_error)
    }

    async fn persist_next_offset(
        &self,
        bot_id: &str,
        offset: i64,
    ) -> Result<(), TelegramStoreError> {
        self.update_telegram_bot(
            bot_id,
            TelegramBotUpdate {
                last_update_id: Some(Some(offset)),
                ..TelegramBotUpdate::default()
            },
        )
        .await
        .map_err(store_error)?;
        Ok(())
    }
}
