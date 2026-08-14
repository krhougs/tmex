use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "watch_rules")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub device_id: String,
    #[sea_orm(column_type = "Text")]
    pub pane_id: String,
    pub enabled: i64,
    #[sea_orm(column_type = "Text")]
    pub trigger_type: String,
    #[sea_orm(column_type = "Text")]
    pub pattern: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub pattern_flags: String,
    pub extract_group: i64,
    #[sea_orm(column_type = "Text")]
    pub condition_prompt: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub provider_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub model_id: Option<String>,
    pub confirm_with_llm: i64,
    pub summarize_with_llm: i64,
    pub interval_seconds: i64,
    pub unchanged_minutes: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub no_match_behavior: String,
    #[sea_orm(column_type = "Text")]
    pub fire_mode: String,
    pub cooldown_seconds: i64,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::devices::Entity",
        from = "Column::DeviceId",
        to = "super::devices::Column::Id",
        fk_name = "watch_rules_device_id_devices_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    Device,
    #[sea_orm(
        belongs_to = "super::llm_providers::Entity",
        from = "Column::ProviderId",
        to = "super::llm_providers::Column::Id",
        fk_name = "watch_rules_provider_id_llm_providers_id_fk",
        on_update = "NoAction",
        on_delete = "SetNull"
    )]
    Provider,
    #[sea_orm(has_one = "super::watch_rule_state::Entity")]
    State,
}

impl Related<super::devices::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Device.def()
    }
}

impl Related<super::llm_providers::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Provider.def()
    }
}

impl Related<super::watch_rule_state::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::State.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
