use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "telegram_bots")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub token_enc: String,
    pub enabled: i64,
    pub allow_auth_requests: i64,
    pub last_update_id: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::telegram_bot_chats::Entity")]
    TelegramBotChats,
}

impl Related<super::telegram_bot_chats::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::TelegramBotChats.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
