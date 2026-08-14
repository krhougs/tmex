use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "devices")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub r#type: String,
    #[sea_orm(column_type = "Text")]
    pub host: Option<String>,
    pub port: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub username: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub ssh_config_ref: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub session: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub auth_mode: String,
    #[sea_orm(column_type = "Text")]
    pub password_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub private_key_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub private_key_passphrase_enc: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub default_working_dir: Option<String>,
    pub sort_order: i64,
    #[sea_orm(column_type = "Text")]
    pub created_at: String,
    #[sea_orm(column_type = "Text")]
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_one = "super::device_runtime_status::Entity")]
    DeviceRuntimeStatus,
    #[sea_orm(has_one = "super::device_tree_order::Entity")]
    DeviceTreeOrder,
    #[sea_orm(has_many = "super::agent_sessions::Entity")]
    AgentSessions,
    #[sea_orm(has_many = "super::watch_rules::Entity")]
    WatchRules,
    #[sea_orm(has_many = "super::file_roots::Entity")]
    FileRoots,
}

impl Related<super::device_runtime_status::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DeviceRuntimeStatus.def()
    }
}

impl Related<super::device_tree_order::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DeviceTreeOrder.def()
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

impl Related<super::file_roots::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FileRoots.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
