use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    #[sea_orm(column_type = "Text")]
    pub search_provider: String,
    #[sea_orm(column_type = "Text")]
    pub tavily_api_key_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub brave_api_key_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub default_provider_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub default_model_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::llm_providers::Entity",
        from = "Column::DefaultProviderId",
        to = "super::llm_providers::Column::Id",
        fk_name = "agent_settings_default_provider_id_llm_providers_id_fk",
        on_update = "NoAction",
        on_delete = "SetNull"
    )]
    DefaultProvider,
}

impl Related<super::llm_providers::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DefaultProvider.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
