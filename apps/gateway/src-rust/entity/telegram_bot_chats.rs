use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "telegram_bot_chats")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub bot_id: String,
    #[sea_orm(column_type = "Text")]
    pub chat_id: String,
    #[sea_orm(column_type = "Text")]
    pub chat_type: String,
    #[sea_orm(column_type = "Text")]
    pub display_name: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
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
        belongs_to = "super::telegram_bots::Entity",
        from = "Column::BotId",
        to = "super::telegram_bots::Column::Id",
        fk_name = "telegram_bot_chats_bot_id_telegram_bots_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    TelegramBot,
}

impl Related<super::telegram_bots::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::TelegramBot.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
