use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::compare_versions;

pub const REGISTRY_URL: &str = "https://registry.npmjs.org/tmex-cli";
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub changelog: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{0}")]
pub struct UpdateCheckError(pub String);

#[derive(Clone, Debug, thiserror::Error)]
#[error("{0}")]
pub struct UpdateRegistryError(pub String);

#[async_trait]
pub trait UpdateRegistry: Send + Sync {
    async fn fetch_packument(&self) -> Result<RegistryPackument, UpdateRegistryError>;
    async fn fetch_changelog(&self, version: &str) -> Option<String>;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RegistryPackument {
    pub latest: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PackumentBody {
    #[serde(rename = "dist-tags")]
    dist_tags: Option<DistTags>,
    time: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct DistTags {
    latest: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ReqwestUpdateRegistry;

#[async_trait]
impl UpdateRegistry for ReqwestUpdateRegistry {
    async fn fetch_packument(&self) -> Result<RegistryPackument, UpdateRegistryError> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .map_err(|error| UpdateRegistryError(error.to_string()))?;
        let response = client
            .get(REGISTRY_URL)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .map_err(|error| UpdateRegistryError(error.to_string()))?;
        if !response.status().is_success() {
            return Err(UpdateRegistryError(format!(
                "npm registry HTTP {}",
                response.status()
            )));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| UpdateRegistryError(error.to_string()))?;
        let body = serde_json::from_slice::<PackumentBody>(&body)
            .map_err(|error| UpdateRegistryError(error.to_string()))?;
        let latest = body.dist_tags.and_then(|tags| tags.latest);
        let published_at = latest.as_ref().and_then(|version| {
            body.time
                .as_ref()
                .and_then(|time| time.get(version))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });
        Ok(RegistryPackument {
            latest,
            published_at,
        })
    }

    async fn fetch_changelog(&self, version: &str) -> Option<String> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .ok()?;
        let response = client
            .get(changelog_url(version))
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

pub fn changelog_url(version: &str) -> String {
    format!("https://cdn.jsdelivr.net/npm/tmex-cli@{version}/CHANGELOG.md")
}

pub async fn check_for_update(
    registry: &dyn UpdateRegistry,
    current_version: &str,
) -> Result<UpdateCheckResult, UpdateCheckError> {
    let packument = registry
        .fetch_packument()
        .await
        .map_err(|error| UpdateCheckError(error.0))?;
    let latest = packument.latest;
    let has_update = latest.as_deref().is_some_and(|latest| {
        current_version != "unknown" && compare_versions(latest, current_version) > 0
    });
    let changelog = match latest.as_deref() {
        Some(version) => registry.fetch_changelog(version).await,
        None => None,
    };
    Ok(UpdateCheckResult {
        current_version: current_version.to_owned(),
        latest_version: latest,
        has_update,
        changelog,
        published_at: packument.published_at,
    })
}

#[cfg(test)]
mod tests {
    use super::{check_for_update, RegistryPackument, UpdateRegistry, UpdateRegistryError};
    use async_trait::async_trait;

    struct FixedRegistry {
        packument: RegistryPackument,
        changelog: Option<String>,
    }

    #[async_trait]
    impl UpdateRegistry for FixedRegistry {
        async fn fetch_packument(&self) -> Result<RegistryPackument, UpdateRegistryError> {
            Ok(self.packument.clone())
        }

        async fn fetch_changelog(&self, _version: &str) -> Option<String> {
            self.changelog.clone()
        }
    }

    #[tokio::test]
    async fn uses_registry_payload_and_semver_to_decide_has_update() {
        let newer = FixedRegistry {
            packument: RegistryPackument {
                latest: Some("1.2.4".to_owned()),
                published_at: Some("2026-08-13T00:00:00.000Z".to_owned()),
            },
            changelog: Some("# 1.2.4".to_owned()),
        };
        let newer_result = check_for_update(&newer, "1.2.3")
            .await
            .expect("newer update check");
        assert_eq!(newer_result.current_version, "1.2.3");
        assert_eq!(newer_result.latest_version.as_deref(), Some("1.2.4"));
        assert!(newer_result.has_update);
        assert_eq!(newer_result.changelog.as_deref(), Some("# 1.2.4"));
        assert_eq!(
            newer_result.published_at.as_deref(),
            Some("2026-08-13T00:00:00.000Z")
        );

        let older = FixedRegistry {
            packument: RegistryPackument {
                latest: Some("1.2.2".to_owned()),
                published_at: None,
            },
            changelog: None,
        };
        let older_result = check_for_update(&older, "1.2.3")
            .await
            .expect("older update check");
        assert!(!older_result.has_update);
        assert_eq!(older_result.latest_version.as_deref(), Some("1.2.2"));
        assert_eq!(older_result.changelog, None);
    }
}
