use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};

use crate::entity::file_roots;

use super::{bool_value, new_id, now_iso, rollback, Repository, RepositoryResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateFileRootInput {
    pub device_id: String,
    pub path: String,
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateFileRootInput {
    pub path: Option<String>,
    pub enabled: Option<bool>,
    pub sort_order: Option<i64>,
}

impl Repository {
    pub async fn get_file_roots(&self) -> RepositoryResult<Vec<file_roots::Model>> {
        Ok(file_roots::Entity::find()
            .order_by_asc(file_roots::Column::SortOrder)
            .order_by_asc(file_roots::Column::Path)
            .all(self.database.orm())
            .await?)
    }

    pub async fn get_file_root_by_id(
        &self,
        id: &str,
    ) -> RepositoryResult<Option<file_roots::Model>> {
        Ok(file_roots::Entity::find_by_id(id.to_owned())
            .one(self.database.orm())
            .await?)
    }

    pub async fn create_file_root(
        &self,
        input: CreateFileRootInput,
    ) -> RepositoryResult<file_roots::Model> {
        let transaction = self.database.begin().await?;
        let result = async {
            let max_sort_order = file_roots::Entity::find()
                .select_only()
                .column_as(file_roots::Column::SortOrder.max(), "max_sort_order")
                .into_tuple::<Option<i64>>()
                .one(transaction.orm())
                .await?
                .flatten()
                .unwrap_or(-1);
            let model = file_roots::Model {
                id: new_id(),
                device_id: input.device_id,
                path: input.path,
                enabled: bool_value(input.enabled.unwrap_or(true)),
                sort_order: max_sort_order + 1,
                created_at: now_iso(),
            };
            file_roots::Entity::insert(file_roots::ActiveModel {
                id: Set(model.id.clone()),
                device_id: Set(model.device_id.clone()),
                path: Set(model.path.clone()),
                enabled: Set(model.enabled),
                sort_order: Set(model.sort_order),
                created_at: Set(model.created_at.clone()),
            })
            .exec_without_returning(transaction.orm())
            .await?;
            RepositoryResult::Ok(model)
        }
        .await;
        let model = match result {
            Ok(model) => model,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(model)
    }

    pub async fn update_file_root(
        &self,
        id: &str,
        updates: UpdateFileRootInput,
    ) -> RepositoryResult<Option<file_roots::Model>> {
        let transaction = self.database.begin().await?;
        let result = async {
            let Some(current) = file_roots::Entity::find_by_id(id.to_owned())
                .one(transaction.orm())
                .await?
            else {
                return RepositoryResult::Ok(None);
            };
            let next = file_roots::Model {
                id: current.id,
                device_id: current.device_id,
                path: updates.path.unwrap_or(current.path),
                enabled: updates.enabled.map(bool_value).unwrap_or(current.enabled),
                sort_order: updates.sort_order.unwrap_or(current.sort_order),
                created_at: current.created_at,
            };
            file_roots::ActiveModel {
                id: Set(next.id.clone()),
                path: Set(next.path.clone()),
                enabled: Set(next.enabled),
                sort_order: Set(next.sort_order),
                ..Default::default()
            }
            .update(transaction.orm())
            .await?;
            RepositoryResult::Ok(Some(next))
        }
        .await;
        let next = match result {
            Ok(next) => next,
            Err(error) => return rollback(transaction, error).await,
        };
        transaction.commit().await?;
        Ok(next)
    }

    pub async fn delete_file_root(&self, id: &str) -> RepositoryResult<bool> {
        let result = file_roots::Entity::delete_many()
            .filter(file_roots::Column::Id.eq(id))
            .exec(self.database.orm())
            .await?;
        Ok(result.rows_affected > 0)
    }
}
