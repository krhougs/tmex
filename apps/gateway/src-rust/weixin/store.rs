use async_trait::async_trait;

use crate::database::repository::{
    Repository, UpsertWeixinUserInput, WeixinAccountUpdate, WeixinContextToken,
};
use crate::entity::{weixin_account_users, weixin_accounts};

use super::WeixinStoreError;

#[async_trait]
pub trait WeixinStore: Send + Sync {
    async fn all_accounts(&self) -> Result<Vec<weixin_accounts::Model>, WeixinStoreError>;

    async fn account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError>;

    async fn update_account(
        &self,
        account_id: &str,
        update: WeixinAccountUpdate,
    ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError>;

    async fn context_tokens(
        &self,
        account_id: &str,
    ) -> Result<Vec<WeixinContextToken>, WeixinStoreError>;

    async fn authorized_users(
        &self,
        account_id: &str,
    ) -> Result<Vec<weixin_account_users::Model>, WeixinStoreError>;

    async fn upsert_user_on_inbound(
        &self,
        input: UpsertWeixinUserInput,
    ) -> Result<Option<weixin_account_users::Model>, WeixinStoreError>;

    async fn set_user_needs_reactivation(
        &self,
        account_id: &str,
        user_id: &str,
        value: bool,
    ) -> Result<(), WeixinStoreError>;
}

#[async_trait]
impl WeixinStore for Repository {
    async fn all_accounts(&self) -> Result<Vec<weixin_accounts::Model>, WeixinStoreError> {
        self.get_all_weixin_accounts()
            .await
            .map_err(|_| WeixinStoreError::new("all_accounts"))
    }

    async fn account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError> {
        self.get_weixin_account_by_id(account_id)
            .await
            .map_err(|_| WeixinStoreError::new("account_by_id"))
    }

    async fn update_account(
        &self,
        account_id: &str,
        update: WeixinAccountUpdate,
    ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError> {
        self.update_weixin_account(account_id, update)
            .await
            .map_err(|_| WeixinStoreError::new("update_account"))
    }

    async fn context_tokens(
        &self,
        account_id: &str,
    ) -> Result<Vec<WeixinContextToken>, WeixinStoreError> {
        self.get_weixin_user_context_tokens(account_id)
            .await
            .map_err(|_| WeixinStoreError::new("context_tokens"))
    }

    async fn authorized_users(
        &self,
        account_id: &str,
    ) -> Result<Vec<weixin_account_users::Model>, WeixinStoreError> {
        self.list_authorized_weixin_users_by_account(account_id)
            .await
            .map_err(|_| WeixinStoreError::new("authorized_users"))
    }

    async fn upsert_user_on_inbound(
        &self,
        input: UpsertWeixinUserInput,
    ) -> Result<Option<weixin_account_users::Model>, WeixinStoreError> {
        self.upsert_weixin_user_on_inbound(input)
            .await
            .map_err(|_| WeixinStoreError::new("upsert_user_on_inbound"))
    }

    async fn set_user_needs_reactivation(
        &self,
        account_id: &str,
        user_id: &str,
        value: bool,
    ) -> Result<(), WeixinStoreError> {
        self.set_weixin_user_needs_reactivation(account_id, user_id, value)
            .await
            .map_err(|_| WeixinStoreError::new("set_user_needs_reactivation"))
    }
}
