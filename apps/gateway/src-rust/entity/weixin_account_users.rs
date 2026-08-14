use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "weixin_account_users")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub account_id: String,
    #[sea_orm(column_type = "Text")]
    pub user_id: String,
    #[sea_orm(column_type = "Text")]
    pub display_name: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub last_context_token: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_inbound_at: Option<String>,
    pub needs_reactivation: i64,
    #[sea_orm(column_type = "Text")]
    pub applied_at: String,
    #[sea_orm(column_type = "Text")]
    pub authorized_at: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::weixin_accounts::Entity",
        from = "Column::AccountId",
        to = "super::weixin_accounts::Column::Id",
        fk_name = "weixin_account_users_account_id_weixin_accounts_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    WeixinAccount,
}

impl Related<super::weixin_accounts::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WeixinAccount.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
