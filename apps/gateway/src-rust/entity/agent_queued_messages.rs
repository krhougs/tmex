use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_queued_messages")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    pub seq: i64,
    #[sea_orm(column_type = "Text")]
    pub text: String,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::agent_sessions::Entity",
        from = "Column::SessionId",
        to = "super::agent_sessions::Column::Id",
        fk_name = "agent_queued_messages_session_id_agent_sessions_id_fk",
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
