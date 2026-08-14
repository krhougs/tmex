use std::collections::{BTreeSet, HashSet};

use icu_collator::{options::CollatorOptions, Collator, CollatorPreferences};
use icu_locale::locale;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};

use crate::entity::llm_providers;

use super::{
    bool_value, json_string_list, new_id, now_iso, parse_string_list, Repository, RepositoryError,
    RepositoryResult,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateLlmProviderInput {
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key_enc: String,
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LlmProviderUpdate {
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key_enc: Option<String>,
    pub enabled: Option<bool>,
    pub models_cache: Option<Option<Vec<String>>>,
    pub models_fetched_at: Option<Option<String>>,
    pub manual_models: Option<Vec<String>>,
    pub disabled_models: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderModelSource {
    Fetched,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderModelInfo {
    pub id: String,
    pub source: ProviderModelSource,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderModels {
    pub effective: Vec<String>,
    pub model_details: Vec<ProviderModelInfo>,
}

pub fn compute_provider_models(record: &llm_providers::Model) -> RepositoryResult<ProviderModels> {
    let fetched = record
        .models_cache
        .as_deref()
        .map(|value| parse_string_list(value, "llm_providers.models_cache"))
        .transpose()?
        .unwrap_or_default();
    let manual = parse_string_list(&record.manual_models, "llm_providers.manual_models")?;
    let disabled = parse_string_list(&record.disabled_models, "llm_providers.disabled_models")?
        .into_iter()
        .collect::<BTreeSet<_>>();

    let mut seen = HashSet::new();
    let mut model_details = Vec::new();
    for id in fetched {
        if seen.insert(id.clone()) {
            model_details.push(ProviderModelInfo {
                enabled: !disabled.contains(&id),
                id,
                source: ProviderModelSource::Fetched,
            });
        }
    }
    for id in manual {
        if seen.insert(id.clone()) {
            model_details.push(ProviderModelInfo {
                enabled: !disabled.contains(&id),
                id,
                source: ProviderModelSource::Manual,
            });
        }
    }
    if let Ok(collator) = Collator::try_new(
        CollatorPreferences::from(locale!("en-US")),
        CollatorOptions::default(),
    ) {
        model_details.sort_by(|left, right| collator.compare(&left.id, &right.id));
    } else {
        model_details.sort_by(|left, right| left.id.cmp(&right.id));
    }
    let effective = model_details
        .iter()
        .filter(|model| model.enabled)
        .map(|model| model.id.clone())
        .collect();
    Ok(ProviderModels {
        effective,
        model_details,
    })
}

impl Repository {
    pub async fn create_llm_provider(
        &self,
        input: CreateLlmProviderInput,
    ) -> RepositoryResult<llm_providers::Model> {
        let now = now_iso();
        let model = llm_providers::Model {
            id: new_id(),
            name: input.name,
            protocol: input.protocol,
            base_url: input.base_url,
            api_key_enc: input.api_key_enc,
            enabled: bool_value(input.enabled.unwrap_or(true)),
            models_cache: None,
            models_fetched_at: None,
            manual_models: "[]".to_owned(),
            disabled_models: "[]".to_owned(),
            created_at: now.clone(),
            updated_at: now,
        };
        llm_providers::Entity::insert(llm_providers::ActiveModel {
            id: Set(model.id.clone()),
            name: Set(model.name.clone()),
            protocol: Set(model.protocol.clone()),
            base_url: Set(model.base_url.clone()),
            api_key_enc: Set(model.api_key_enc.clone()),
            enabled: Set(model.enabled),
            models_cache: Set(model.models_cache.clone()),
            models_fetched_at: Set(model.models_fetched_at.clone()),
            manual_models: Set(model.manual_models.clone()),
            disabled_models: Set(model.disabled_models.clone()),
            created_at: Set(model.created_at.clone()),
            updated_at: Set(model.updated_at.clone()),
        })
        .exec_without_returning(self.database.orm())
        .await?;
        self.get_llm_provider_by_id(&model.id)
            .await?
            .ok_or(RepositoryError::MissingAfterWrite("llm provider"))
    }

    pub async fn get_llm_provider_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<llm_providers::Model>> {
        Ok(llm_providers::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn get_all_llm_providers(&self) -> RepositoryResult<Vec<llm_providers::Model>> {
        Ok(llm_providers::Entity::find()
            .order_by_desc(llm_providers::Column::CreatedAt)
            .all(self.database.orm())
            .await?)
    }

    pub async fn update_llm_provider(
        &self,
        id: &str,
        updates: LlmProviderUpdate,
    ) -> RepositoryResult<Option<llm_providers::Model>> {
        let mut model = llm_providers::ActiveModel {
            id: Set(id.to_owned()),
            updated_at: Set(now_iso()),
            ..Default::default()
        };
        if let Some(value) = updates.name {
            model.name = Set(value);
        }
        if let Some(value) = updates.protocol {
            model.protocol = Set(value);
        }
        if let Some(value) = updates.base_url {
            model.base_url = Set(value);
        }
        if let Some(value) = updates.api_key_enc {
            model.api_key_enc = Set(value);
        }
        if let Some(value) = updates.enabled {
            model.enabled = Set(bool_value(value));
        }
        if let Some(value) = updates.models_cache {
            model.models_cache = Set(value.map(|value| json_string_list(&value)));
        }
        if let Some(value) = updates.models_fetched_at {
            model.models_fetched_at = Set(value);
        }
        if let Some(value) = updates.manual_models {
            model.manual_models = Set(json_string_list(&value));
        }
        if let Some(value) = updates.disabled_models {
            model.disabled_models = Set(json_string_list(&value));
        }
        llm_providers::Entity::update_many()
            .set(model)
            .filter(llm_providers::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        self.get_llm_provider_by_id(id).await
    }

    pub async fn delete_llm_provider(&self, id: &str) -> RepositoryResult<()> {
        llm_providers::Entity::delete_by_id(id.to_owned())
            .exec(self.database.orm())
            .await?;
        Ok(())
    }
}
