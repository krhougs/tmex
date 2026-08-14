use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "device_runtime_status")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub device_id: String,
    #[sea_orm(column_type = "Text")]
    pub last_seen_at: Option<String>,
    pub tmux_available: i64,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_error_type: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::devices::Entity",
        from = "Column::DeviceId",
        to = "super::devices::Column::Id",
        fk_name = "device_runtime_status_device_id_devices_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    Device,
}

impl Related<super::devices::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Device.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
