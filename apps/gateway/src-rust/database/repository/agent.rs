use sea_orm::entity::prelude::Json;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set};
use serde_json::json;

use crate::entity::{
    agent_confirmations, agent_messages, agent_queued_messages, agent_sessions, agent_settings,
};

use super::{
    bool_value, json_string_list, new_id, now_iso, rollback, Repository, RepositoryError,
    RepositoryResult,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSettingsUpdate {
    pub search_provider: Option<String>,
    pub tavily_api_key_enc: Option<Option<String>>,
    pub brave_api_key_enc: Option<Option<String>>,
    pub default_provider_id: Option<Option<String>>,
    pub default_model_id: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateAgentSessionInput {
    pub title: String,
    pub device_id: Option<String>,
    pub pane_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: String,
    pub system_prompt: Option<String>,
    pub write_mode: Option<String>,
    pub use_provider_web_search: Option<bool>,
    pub provider_hosted_tools: Option<Vec<String>>,
    pub allow_control_chars: Option<bool>,
    pub origin_pane_title: Option<String>,
    pub origin_process_name: Option<String>,
    pub max_steps_per_turn: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSessionUpdate {
    pub title: Option<String>,
    pub device_id: Option<Option<String>>,
    pub pane_id: Option<Option<String>>,
    pub provider_id: Option<Option<String>>,
    pub model_id: Option<String>,
    pub system_prompt: Option<Option<String>>,
    pub write_mode: Option<String>,
    pub use_provider_web_search: Option<bool>,
    pub provider_hosted_tools: Option<Vec<String>>,
    pub allow_control_chars: Option<bool>,
    pub status: Option<String>,
    pub last_error: Option<Option<String>>,
    pub max_steps_per_turn: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CreateAgentConfirmationInput {
    pub id: Option<String>,
    pub session_id: String,
    pub tool_name: String,
    pub tool_call_id: String,
    pub input_json: Json,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentConfirmationDecision {
    pub status: String,
    pub reason: Option<String>,
}

impl Repository {
    pub async fn ensure_agent_settings_initialized(&self) -> RepositoryResult<()> {
        agent_settings::Entity::insert(agent_settings::ActiveModel {
            id: Set(1),
            search_provider: Set("none".to_owned()),
            tavily_api_key_enc: Set(None),
            brave_api_key_enc: Set(None),
            default_provider_id: Set(None),
            default_model_id: Set(None),
            updated_at: Set(now_iso()),
        })
        .on_conflict(
            OnConflict::column(agent_settings::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(self.database.orm())
        .await?;
        Ok(())
    }

    pub async fn get_agent_settings(&self) -> RepositoryResult<agent_settings::Model> {
        if let Some(model) = agent_settings::Entity::find_by_id(1)
            .one(self.database.orm())
            .await?
        {
            return Ok(model);
        }
        self.ensure_agent_settings_initialized().await?;
        agent_settings::Entity::find_by_id(1)
            .one(self.database.orm())
            .await?
            .ok_or(RepositoryError::NotInitialized("agent_settings"))
    }

    pub async fn update_agent_settings(
        &self,
        updates: AgentSettingsUpdate,
    ) -> RepositoryResult<agent_settings::Model> {
        self.get_agent_settings().await?;
        let mut model = agent_settings::ActiveModel {
            id: Set(1),
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.search_provider {
            model.search_provider = Set(value);
        }
        if let Some(value) = updates.tavily_api_key_enc {
            model.tavily_api_key_enc = Set(value);
        }
        if let Some(value) = updates.brave_api_key_enc {
            model.brave_api_key_enc = Set(value);
        }
        if let Some(value) = updates.default_provider_id {
            model.default_provider_id = Set(value);
        }
        if let Some(value) = updates.default_model_id {
            model.default_model_id = Set(value);
        }
        agent_settings::Entity::update(model)
            .exec(self.database.orm())
            .await?;
        self.get_agent_settings().await
    }

    pub async fn create_agent_session(
        &self,
        input: CreateAgentSessionInput,
    ) -> RepositoryResult<agent_sessions::Model> {
        let now = now_iso();
        let model = agent_sessions::Model {
            id: new_id(),
            title: input.title,
            device_id: input.device_id,
            pane_id: input.pane_id,
            provider_id: input.provider_id,
            model_id: input.model_id,
            system_prompt: input.system_prompt,
            write_mode: input.write_mode.unwrap_or_else(|| "confirm".to_owned()),
            use_provider_web_search: bool_value(input.use_provider_web_search.unwrap_or(false)),
            provider_hosted_tools: json_string_list(
                &input.provider_hosted_tools.unwrap_or_default(),
            ),
            allow_control_chars: bool_value(input.allow_control_chars.unwrap_or(false)),
            origin_pane_title: input.origin_pane_title,
            origin_process_name: input.origin_process_name,
            status: "idle".to_owned(),
            last_error: None,
            max_steps_per_turn: input.max_steps_per_turn.unwrap_or(25),
            created_at: now.clone(),
            updated_at: now,
        };
        agent_sessions::Entity::insert(agent_sessions::ActiveModel {
            id: Set(model.id.clone()),
            title: Set(model.title.clone()),
            device_id: Set(model.device_id.clone()),
            pane_id: Set(model.pane_id.clone()),
            provider_id: Set(model.provider_id.clone()),
            model_id: Set(model.model_id.clone()),
            system_prompt: Set(model.system_prompt.clone()),
            write_mode: Set(model.write_mode.clone()),
            use_provider_web_search: Set(model.use_provider_web_search),
            provider_hosted_tools: Set(model.provider_hosted_tools.clone()),
            allow_control_chars: Set(model.allow_control_chars),
            origin_pane_title: Set(model.origin_pane_title.clone()),
            origin_process_name: Set(model.origin_process_name.clone()),
            status: Set(model.status.clone()),
            last_error: Set(model.last_error.clone()),
            max_steps_per_turn: Set(model.max_steps_per_turn),
            created_at: Set(model.created_at.clone()),
            updated_at: Set(model.updated_at.clone()),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        self.get_agent_session_by_id(&model.id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("agent session"))
    }

    pub async fn get_agent_session_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<agent_sessions::Model>> {
        Ok(agent_sessions::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_agent_sessions(&self) -> RepositoryResult<Vec<agent_sessions::Model>> {
        Ok(agent_sessions::Entity::find()
            .order_by_desc(agent_sessions::Column::UpdatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_agent_sessions_by_status(
        &self,
        status: &str,
    ) -> RepositoryResult<Vec<agent_sessions::Model>> {
        Ok(agent_sessions::Entity::find()
            .filter(agent_sessions::Column::Status.eq(status))
            .order_by_desc(agent_sessions::Column::UpdatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn update_agent_session(
        &self,
        id: &str,
        updates: AgentSessionUpdate,
    ) -> RepositoryResult<Option<agent_sessions::Model>> {
        let mut model = agent_sessions::ActiveModel {
            id: Set(id.to_owned()),
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.title {
            model.title = Set(value);
        }
        if let Some(value) = updates.device_id {
            model.device_id = Set(value);
        }
        if let Some(value) = updates.pane_id {
            model.pane_id = Set(value);
        }
        if let Some(value) = updates.provider_id {
            model.provider_id = Set(value);
        }
        if let Some(value) = updates.model_id {
            model.model_id = Set(value);
        }
        if let Some(value) = updates.system_prompt {
            model.system_prompt = Set(value);
        }
        if let Some(value) = updates.write_mode {
            model.write_mode = Set(value);
        }
        if let Some(value) = updates.use_provider_web_search {
            model.use_provider_web_search = Set(bool_value(value));
        }
        if let Some(value) = updates.provider_hosted_tools {
            model.provider_hosted_tools = Set(json_string_list(&value));
        }
        if let Some(value) = updates.allow_control_chars {
            model.allow_control_chars = Set(bool_value(value));
        }
        if let Some(value) = updates.status {
            model.status = Set(value);
        }
        if let Some(value) = updates.last_error {
            model.last_error = Set(value);
        }
        if let Some(value) = updates.max_steps_per_turn {
            model.max_steps_per_turn = Set(value);
        }
        agent_sessions::Entity::update_many()
            .set(model)
            .filter(agent_sessions::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        self.get_agent_session_by_id(id).await
    }

    pub async fn delete_agent_session(&self, id: &str) -> RepositoryResult<()> {
        agent_sessions::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn append_agent_message(
        &self,
        session_id: &str,
        role: &str,
        content: Json,
    ) -> RepositoryResult<agent_messages::Model> {
        let transaction = self.database.begin().await?;
        let id = new_id();
        let created_at = now_iso();
        let result = async {
            let max_seq = agent_messages::Entity::find()
                .filter(agent_messages::Column::SessionId.eq(session_id))
                .select_only()
                .column_as(agent_messages::Column::Seq.max(), "max_seq")
                .into_tuple::<Option<i64>>()
                .one(transaction.orm())
                .await?
                .flatten()
                .unwrap_or(-1);
            agent_messages::Entity::insert(agent_messages::ActiveModel {
                id: Set(id.clone()),
                session_id: Set(session_id.to_owned()),
                seq: Set(max_seq + 1),
                role: Set(role.to_owned()),
                content: Set(content.to_string()),
                created_at: Set(created_at.clone()),
            })
            .exec_without_returning(transaction.orm())
            .await?;
            RepositoryResult::Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        self.get_agent_message_by_id(&id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("agent message"))
    }

    async fn get_agent_message_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<agent_messages::Model>> {
        Ok(agent_messages::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn list_agent_messages(
        &self,
        session_id: &str,
        after_seq: Option<i64>,
    ) -> RepositoryResult<Vec<agent_messages::Model>> {
        let mut query =
            agent_messages::Entity::find().filter(agent_messages::Column::SessionId.eq(session_id));
        if let Some(after_seq) = after_seq {
            query = query.filter(agent_messages::Column::Seq.gt(after_seq));
        }
        Ok(query
            .order_by_asc(agent_messages::Column::Seq)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_max_agent_message_seq(&self, session_id: &str) -> RepositoryResult<i64> {
        Ok(agent_messages::Entity::find()
            .filter(agent_messages::Column::SessionId.eq(session_id))
            .select_only()
            .column_as(agent_messages::Column::Seq.max(), "max_seq")
            .into_tuple::<Option<i64>>()
            .one(self.database.orm())
            .await?
            .flatten()
            .unwrap_or(-1))
    }

    pub async fn enqueue_agent_message(
        &self,
        session_id: &str,
        text: &str,
    ) -> RepositoryResult<agent_queued_messages::Model> {
        let transaction = self.database.begin().await?;
        let id = new_id();
        let created_at = now_iso();
        let result = async {
            let max_seq = agent_queued_messages::Entity::find()
                .filter(agent_queued_messages::Column::SessionId.eq(session_id))
                .select_only()
                .column_as(agent_queued_messages::Column::Seq.max(), "max_seq")
                .into_tuple::<Option<i64>>()
                .one(transaction.orm())
                .await?
                .flatten()
                .unwrap_or(-1);
            agent_queued_messages::Entity::insert(agent_queued_messages::ActiveModel {
                id: Set(id.clone()),
                session_id: Set(session_id.to_owned()),
                seq: Set(max_seq + 1),
                text: Set(text.to_owned()),
                created_at: Set(created_at.clone()),
            })
            .exec_without_returning(transaction.orm())
            .await?;
            RepositoryResult::Ok(())
        }
        .await;
        if let Err(error) = result {
            return rollback(transaction, error).await;
        }
        transaction.commit().await?;
        self.get_queued_agent_message_by_id(&id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("queued agent message"))
    }

    pub async fn list_queued_agent_messages(
        &self,
        session_id: &str,
    ) -> RepositoryResult<Vec<agent_queued_messages::Model>> {
        Ok(agent_queued_messages::Entity::find()
            .filter(agent_queued_messages::Column::SessionId.eq(session_id))
            .order_by_asc(agent_queued_messages::Column::Seq)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_queued_agent_message_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<agent_queued_messages::Model>> {
        Ok(agent_queued_messages::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn update_queued_agent_message(
        &self,
        id: &str,
        text: &str,
    ) -> RepositoryResult<Option<agent_queued_messages::Model>> {
        agent_queued_messages::Entity::update_many()
            .set(agent_queued_messages::ActiveModel {
                text: Set(text.to_owned()),
                ..Default::default()
            })
            .filter(agent_queued_messages::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        self.get_queued_agent_message_by_id(id).await
    }

    pub async fn delete_queued_agent_message(&self, id: &str) -> RepositoryResult<()> {
        agent_queued_messages::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn delete_all_queued_agent_messages(&self, session_id: &str) -> RepositoryResult<()> {
        agent_queued_messages::Entity::delete_many()
            .filter(agent_queued_messages::Column::SessionId.eq(session_id))
            .exec(self.database.orm())
            .await?;
        Ok(())
    }

    pub async fn drain_queued_agent_messages(
        &self,
        session_id: &str,
    ) -> RepositoryResult<Vec<agent_messages::Model>> {
        let transaction = self.database.begin().await?;
        let result = async {
            let queued = agent_queued_messages::Entity::find()
                .filter(agent_queued_messages::Column::SessionId.eq(session_id))
                .order_by_asc(agent_queued_messages::Column::Seq)
                .all(transaction.orm())
                .await?;
            if queued.is_empty() {
                return RepositoryResult::Ok(Vec::new());
            }

            let max_seq = agent_messages::Entity::find()
                .filter(agent_messages::Column::SessionId.eq(session_id))
                .select_only()
                .column_as(agent_messages::Column::Seq.max(), "max_seq")
                .into_tuple::<Option<i64>>()
                .one(transaction.orm())
                .await?
                .flatten()
                .unwrap_or(-1);
            let mut messages = Vec::with_capacity(queued.len());
            for (offset, item) in queued.into_iter().enumerate() {
                let message = agent_messages::Model {
                    id: new_id(),
                    session_id: session_id.to_owned(),
                    seq: max_seq + offset as i64 + 1,
                    role: "user".to_owned(),
                    content: json!({"role":"user","content":item.text}).to_string(),
                    created_at: now_iso(),
                };
                agent_messages::Entity::insert(agent_messages::ActiveModel {
                    id: Set(message.id.clone()),
                    session_id: Set(message.session_id.clone()),
                    seq: Set(message.seq),
                    role: Set(message.role.clone()),
                    content: Set(message.content.clone()),
                    created_at: Set(message.created_at.clone()),
                })
                .exec_without_returning(transaction.orm())
                .await?;
                messages.push(message);
            }
            agent_queued_messages::Entity::delete_many()
                .filter(agent_queued_messages::Column::SessionId.eq(session_id))
                .exec(transaction.orm())
                .await?;
            RepositoryResult::Ok(messages)
        }
        .await;
        let messages = match result {
            Ok(messages) => messages,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(messages)
    }

    pub async fn create_agent_confirmation(
        &self,
        input: CreateAgentConfirmationInput,
    ) -> RepositoryResult<agent_confirmations::Model> {
        let model = agent_confirmations::Model {
            id: input.id.unwrap_or_else(new_id),
            session_id: input.session_id,
            tool_name: input.tool_name,
            tool_call_id: input.tool_call_id,
            input_json: input.input_json.to_string(),
            status: "pending".to_owned(),
            reason: None,
            decided_at: None,
            created_at: now_iso(),
        };
        agent_confirmations::Entity::insert(agent_confirmations::ActiveModel {
            id: Set(model.id.clone()),
            session_id: Set(model.session_id.clone()),
            tool_name: Set(model.tool_name.clone()),
            tool_call_id: Set(model.tool_call_id.clone()),
            input_json: Set(model.input_json.clone()),
            status: Set(model.status.clone()),
            reason: Set(model.reason.clone()),
            decided_at: Set(model.decided_at.clone()),
            created_at: Set(model.created_at.clone()),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        self.get_agent_confirmation_by_id(&model.id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("agent confirmation"))
    }

    pub async fn get_agent_confirmation_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<agent_confirmations::Model>> {
        Ok(agent_confirmations::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn list_pending_agent_confirmations(
        &self,
        session_id: &str,
    ) -> RepositoryResult<Vec<agent_confirmations::Model>> {
        Ok(agent_confirmations::Entity::find()
            .filter(agent_confirmations::Column::SessionId.eq(session_id))
            .filter(agent_confirmations::Column::Status.eq("pending"))
            .order_by_asc(agent_confirmations::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn decide_agent_confirmation(
        &self,
        id: &str,
        decision: AgentConfirmationDecision,
    ) -> RepositoryResult<Option<agent_confirmations::Model>> {
        let result = agent_confirmations::Entity::update_many()
            .set(agent_confirmations::ActiveModel {
                status: Set(decision.status),
                reason: Set(decision.reason),
                decided_at: Set(Some(now_iso())),
                ..Default::default()
            })
            .filter(agent_confirmations::Column::Id.eq(id))
            .filter(agent_confirmations::Column::Status.eq("pending"))
            .exec(self.database.orm())
            .await?;
        if result.rows_affected == 0 {
            return Ok(None);
        }
        self.get_agent_confirmation_by_id(id).await
    }
}
