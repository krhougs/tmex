use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};

use crate::entity::{watch_rule_state, watch_rules};

use super::{bool_value, new_id, now_iso, Repository, RepositoryError, RepositoryResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateWatchRuleInput {
    pub name: String,
    pub device_id: String,
    pub pane_id: String,
    pub enabled: Option<bool>,
    pub trigger_type: String,
    pub pattern: Option<String>,
    pub pattern_flags: Option<String>,
    pub extract_group: Option<i64>,
    pub condition_prompt: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub confirm_with_llm: Option<bool>,
    pub summarize_with_llm: Option<bool>,
    pub interval_seconds: Option<i64>,
    pub unchanged_minutes: Option<i64>,
    pub no_match_behavior: Option<String>,
    pub fire_mode: Option<String>,
    pub cooldown_seconds: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchRuleUpdate {
    pub name: Option<String>,
    pub device_id: Option<String>,
    pub pane_id: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_type: Option<String>,
    pub pattern: Option<Option<String>>,
    pub pattern_flags: Option<String>,
    pub extract_group: Option<i64>,
    pub condition_prompt: Option<Option<String>>,
    pub provider_id: Option<Option<String>>,
    pub model_id: Option<Option<String>>,
    pub confirm_with_llm: Option<bool>,
    pub summarize_with_llm: Option<bool>,
    pub interval_seconds: Option<i64>,
    pub unchanged_minutes: Option<Option<i64>>,
    pub no_match_behavior: Option<String>,
    pub fire_mode: Option<String>,
    pub cooldown_seconds: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchRuleStateUpdate {
    pub last_sampled_at: Option<Option<String>>,
    pub last_value: Option<Option<String>>,
    pub last_value_changed_at: Option<Option<String>>,
    pub triggered_since_change: Option<bool>,
    pub last_triggered_at: Option<Option<String>>,
    pub consecutive_errors: Option<i64>,
    pub last_error: Option<Option<String>>,
    pub model_unavailable_notified: Option<bool>,
}

impl Repository {
    pub async fn create_watch_rule(
        &self,
        input: CreateWatchRuleInput,
    ) -> RepositoryResult<watch_rules::Model> {
        let now = now_iso();
        let model = watch_rules::Model {
            id: new_id(),
            name: input.name,
            device_id: input.device_id,
            pane_id: input.pane_id,
            enabled: bool_value(input.enabled.unwrap_or(true)),
            trigger_type: input.trigger_type,
            pattern: input.pattern,
            pattern_flags: input.pattern_flags.unwrap_or_default(),
            extract_group: input.extract_group.unwrap_or(0),
            condition_prompt: input.condition_prompt,
            provider_id: input.provider_id,
            model_id: input.model_id,
            confirm_with_llm: bool_value(input.confirm_with_llm.unwrap_or(false)),
            summarize_with_llm: bool_value(input.summarize_with_llm.unwrap_or(false)),
            interval_seconds: input.interval_seconds.unwrap_or(30),
            unchanged_minutes: input.unchanged_minutes,
            no_match_behavior: input
                .no_match_behavior
                .unwrap_or_else(|| "reset".to_owned()),
            fire_mode: input.fire_mode.unwrap_or_else(|| "once".to_owned()),
            cooldown_seconds: input.cooldown_seconds.unwrap_or(600),
            created_at: now.clone(),
            updated_at: now,
        };
        watch_rules::Entity::insert(watch_rules::ActiveModel {
            id: Set(model.id.clone()),
            name: Set(model.name.clone()),
            device_id: Set(model.device_id.clone()),
            pane_id: Set(model.pane_id.clone()),
            enabled: Set(model.enabled),
            trigger_type: Set(model.trigger_type.clone()),
            pattern: Set(model.pattern.clone()),
            pattern_flags: Set(model.pattern_flags.clone()),
            extract_group: Set(model.extract_group),
            condition_prompt: Set(model.condition_prompt.clone()),
            provider_id: Set(model.provider_id.clone()),
            model_id: Set(model.model_id.clone()),
            confirm_with_llm: Set(model.confirm_with_llm),
            summarize_with_llm: Set(model.summarize_with_llm),
            interval_seconds: Set(model.interval_seconds),
            unchanged_minutes: Set(model.unchanged_minutes),
            no_match_behavior: Set(model.no_match_behavior.clone()),
            fire_mode: Set(model.fire_mode.clone()),
            cooldown_seconds: Set(model.cooldown_seconds),
            created_at: Set(model.created_at.clone()),
            updated_at: Set(model.updated_at.clone()),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        self.get_watch_rule_by_id(&model.id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("watch rule"))
    }

    pub async fn get_watch_rule_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<watch_rules::Model>> {
        Ok(watch_rules::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_watch_rules(&self) -> RepositoryResult<Vec<watch_rules::Model>> {
        Ok(watch_rules::Entity::find()
            .order_by_desc(watch_rules::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_enabled_watch_rules(&self) -> RepositoryResult<Vec<watch_rules::Model>> {
        Ok(watch_rules::Entity::find()
            .filter(watch_rules::Column::Enabled.eq(1_i64))
            .order_by_desc(watch_rules::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn list_watch_rules_by_device(
        &self,
        device_id: &str,
    ) -> RepositoryResult<Vec<watch_rules::Model>> {
        Ok(watch_rules::Entity::find()
            .filter(watch_rules::Column::DeviceId.eq(device_id))
            .order_by_desc(watch_rules::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn update_watch_rule(
        &self,
        id: &str,
        updates: WatchRuleUpdate,
    ) -> RepositoryResult<Option<watch_rules::Model>> {
        let mut model = watch_rules::ActiveModel {
            id: Set(id.to_owned()),
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.name {
            model.name = Set(value);
        }
        if let Some(value) = updates.device_id {
            model.device_id = Set(value);
        }
        if let Some(value) = updates.pane_id {
            model.pane_id = Set(value);
        }
        if let Some(value) = updates.enabled {
            model.enabled = Set(bool_value(value));
        }
        if let Some(value) = updates.trigger_type {
            model.trigger_type = Set(value);
        }
        if let Some(value) = updates.pattern {
            model.pattern = Set(value);
        }
        if let Some(value) = updates.pattern_flags {
            model.pattern_flags = Set(value);
        }
        if let Some(value) = updates.extract_group {
            model.extract_group = Set(value);
        }
        if let Some(value) = updates.condition_prompt {
            model.condition_prompt = Set(value);
        }
        if let Some(value) = updates.provider_id {
            model.provider_id = Set(value);
        }
        if let Some(value) = updates.model_id {
            model.model_id = Set(value);
        }
        if let Some(value) = updates.confirm_with_llm {
            model.confirm_with_llm = Set(bool_value(value));
        }
        if let Some(value) = updates.summarize_with_llm {
            model.summarize_with_llm = Set(bool_value(value));
        }
        if let Some(value) = updates.interval_seconds {
            model.interval_seconds = Set(value);
        }
        if let Some(value) = updates.unchanged_minutes {
            model.unchanged_minutes = Set(value);
        }
        if let Some(value) = updates.no_match_behavior {
            model.no_match_behavior = Set(value);
        }
        if let Some(value) = updates.fire_mode {
            model.fire_mode = Set(value);
        }
        if let Some(value) = updates.cooldown_seconds {
            model.cooldown_seconds = Set(value);
        }
        watch_rules::Entity::update_many()
            .set(model)
            .filter(watch_rules::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        self.get_watch_rule_by_id(id).await
    }

    pub async fn delete_watch_rule(&self, id: &str) -> RepositoryResult<()> {
        watch_rules::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn get_watch_rule_state(
        &self,
        rule_id: &str,
    ) -> RepositoryResult<Option<watch_rule_state::Model>> {
        Ok(watch_rule_state::Entity::find_by_id(rule_id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn upsert_watch_rule_state(
        &self,
        rule_id: &str,
        updates: WatchRuleStateUpdate,
    ) -> RepositoryResult<watch_rule_state::Model> {
        let mut model = watch_rule_state::ActiveModel {
            rule_id: Set(rule_id.to_owned()),
            ..Default::default()
        };
        let mut columns = Vec::new();
        if let Some(value) = updates.last_sampled_at {
            model.last_sampled_at = Set(value);
            columns.push(watch_rule_state::Column::LastSampledAt);
        }
        if let Some(value) = updates.last_value {
            model.last_value = Set(value);
            columns.push(watch_rule_state::Column::LastValue);
        }
        if let Some(value) = updates.last_value_changed_at {
            model.last_value_changed_at = Set(value);
            columns.push(watch_rule_state::Column::LastValueChangedAt);
        }
        if let Some(value) = updates.triggered_since_change {
            model.triggered_since_change = Set(bool_value(value));
            columns.push(watch_rule_state::Column::TriggeredSinceChange);
        }
        if let Some(value) = updates.last_triggered_at {
            model.last_triggered_at = Set(value);
            columns.push(watch_rule_state::Column::LastTriggeredAt);
        }
        if let Some(value) = updates.consecutive_errors {
            model.consecutive_errors = Set(value);
            columns.push(watch_rule_state::Column::ConsecutiveErrors);
        }
        if let Some(value) = updates.last_error {
            model.last_error = Set(value);
            columns.push(watch_rule_state::Column::LastError);
        }
        if let Some(value) = updates.model_unavailable_notified {
            model.model_unavailable_notified = Set(bool_value(value));
            columns.push(watch_rule_state::Column::ModelUnavailableNotified);
        }

        let mut conflict = OnConflict::column(watch_rule_state::Column::RuleId);
        if columns.is_empty() {
            conflict.do_nothing();
        } else {
            conflict.update_columns(columns);
        }
        watch_rule_state::Entity::insert(model)
            .on_conflict(conflict.to_owned())
            .exec_without_returning(self.database.orm())
            .await?;
        self.get_watch_rule_state(rule_id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("watch rule state"))
    }
}
