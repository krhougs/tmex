use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "llm_providers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub protocol: String,
    #[sea_orm(column_type = "Text")]
    pub base_url: String,
    #[sea_orm(column_type = "Text")]
    pub api_key_enc: String,
    pub enabled: i64,
    #[sea_orm(column_type = "Text")]
    pub models_cache: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub models_fetched_at: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub manual_models: String,
    #[sea_orm(column_type = "Text")]
    pub disabled_models: String,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::agent_settings::Entity")]
    AgentSettings,
    #[sea_orm(has_many = "super::agent_sessions::Entity")]
    AgentSessions,
    #[sea_orm(has_many = "super::watch_rules::Entity")]
    WatchRules,
}

impl Related<super::agent_settings::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentSettings.def()
    }
}

impl Related<super::agent_sessions::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentSessions.def()
    }
}

impl Related<super::watch_rules::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WatchRules.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
