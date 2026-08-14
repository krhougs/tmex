use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "site_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    #[sea_orm(column_type = "Text")]
    pub site_name: String,
    #[sea_orm(column_type = "Text")]
    pub site_url: String,
    pub bell_throttle_seconds: i64,
    pub notification_throttle_seconds: i64,
    pub enable_browser_notification_toast: i64,
    pub enable_notification_push: i64,
    pub enable_bell_push: i64,
    pub enable_bell_sound: i64,
    pub ssh_reconnect_max_retries: i64,
    pub ssh_reconnect_delay_seconds: i64,
    #[sea_orm(column_type = "Text")]
    pub language: String,
    #[sea_orm(column_type = "Text")]
    pub theme: String,
    #[sea_orm(column_type = "Text")]
    pub disabled_notification_channels: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
