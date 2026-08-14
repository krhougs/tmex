use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_confirmations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    #[sea_orm(column_type = "Text")]
    pub tool_name: String,
    #[sea_orm(column_type = "Text")]
    pub tool_call_id: String,
    #[sea_orm(column_type = "Text")]
    pub input_json: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub reason: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub decided_at: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::agent_sessions::Entity",
        from = "Column::SessionId",
        to = "super::agent_sessions::Column::Id",
        fk_name = "agent_confirmations_session_id_agent_sessions_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    AgentSession,
}

impl Related<super::agent_sessions::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AgentSession.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
