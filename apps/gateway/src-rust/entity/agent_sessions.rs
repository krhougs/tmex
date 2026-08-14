use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub device_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub pane_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub provider_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub model_id: String,
    #[sea_orm(column_type = "Text")]
    pub system_prompt: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub write_mode: String,
    pub use_provider_web_search: i64,
    #[sea_orm(column_type = "Text")]
    pub provider_hosted_tools: String,
    pub allow_control_chars: i64,
    #[sea_orm(column_type = "Text")]
    pub origin_pane_title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub origin_process_name: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    pub max_steps_per_turn: i64,
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
        fk_name = "agent_sessions_device_id_devices_id_fk",
        on_update = "NoAction",
        on_delete = "SetNull"
    )]
    Device,
    #[sea_orm(
        belongs_to = "super::llm_providers::Entity",
        from = "Column::ProviderId",
        to = "super::llm_providers::Column::Id",
        fk_name = "agent_sessions_provider_id_llm_providers_id_fk",
        on_update = "NoAction",
        on_delete = "SetNull"
    )]
    Provider,
    #[sea_orm(has_many = "super::agent_messages::Entity")]
    AgentMessages,
    #[sea_orm(has_many = "super::agent_queued_messages::Entity")]
    AgentQueuedMessages,
    #[sea_orm(has_many = "super::agent_confirmations::Entity")]
    AgentConfirmations,
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

impl Related<super::agent_messages::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentMessages.def()
    }
}

impl Related<super::agent_queued_messages::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentQueuedMessages.def()
    }
}

impl Related<super::agent_confirmations::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentConfirmations.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
