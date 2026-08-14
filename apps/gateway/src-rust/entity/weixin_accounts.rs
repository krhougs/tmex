use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "weixin_accounts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    pub enabled: i64,
    pub allow_auth_requests: i64,
    #[sea_orm(column_type = "Text")]
    pub weixin_uin: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub bot_token_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub base_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub sync_buf: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::weixin_account_users::Entity")]
    WeixinAccountUsers,
}

impl Related<super::weixin_account_users::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WeixinAccountUsers.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
