use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "watch_rule_state")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub rule_id: String,
    #[sea_orm(column_type = "Text")]
    pub last_sampled_at: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_value: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_value_changed_at: Option<String>,
    pub triggered_since_change: i64,
    #[sea_orm(column_type = "Text")]
    pub last_triggered_at: Option<String>,
    pub consecutive_errors: i64,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    pub model_unavailable_notified: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::watch_rules::Entity",
        from = "Column::RuleId",
        to = "super::watch_rules::Column::Id",
        fk_name = "watch_rule_state_rule_id_watch_rules_id_fk",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    WatchRule,
}

impl Related<super::watch_rules::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WatchRule.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
