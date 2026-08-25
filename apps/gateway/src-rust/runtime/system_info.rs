use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use tmex_protocol::TERMINAL_PASTE_MAX_BYTES;

use crate::config::{
    GatewayConfig, GatewayEntryMode, ManagementMode, UpdateOwner, GATEWAY_VERSION,
};
use crate::files::PASTE_IMAGE_MAX_BYTES;
use crate::http::SystemInfo;

use super::ports::{GatewayRuntimePortError, GatewaySystemInfoProvider};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayDeployment {
    Launchd,
    Systemd,
    None,
}

impl GatewayDeployment {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Launchd => "launchd",
            Self::Systemd => "systemd",
            Self::None => "none",
        }
    }

    fn from_platform(platform: &str) -> Self {
        match platform {
            "darwin" => Self::Launchd,
            "linux" => Self::Systemd,
            _ => Self::None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayHostSystemInfo {
    pub base_version: String,
    pub installed_via_cli: bool,
    pub deployment: GatewayDeployment,
    pub service_name: Option<String>,
}

impl Default for GatewayHostSystemInfo {
    fn default() -> Self {
        Self {
            base_version: GATEWAY_VERSION.to_owned(),
            installed_via_cli: false,
            deployment: GatewayDeployment::None,
            service_name: None,
        }
    }
}

#[derive(Clone, Debug)]
enum GatewaySystemInfoSource {
    InstallMeta {
        install_dir: PathBuf,
        fallback_platform: &'static str,
    },
    Host(GatewayHostSystemInfo),
}

#[derive(Clone, Debug)]
pub struct ProductionGatewaySystemInfoProvider {
    config: GatewayConfig,
    source: GatewaySystemInfoSource,
}

impl ProductionGatewaySystemInfoProvider {
    pub fn from_process(config: GatewayConfig) -> Result<Self, GatewayRuntimePortError> {
        if config.entry_mode == GatewayEntryMode::Embedded {
            return Ok(Self::with_host_info(
                config,
                GatewayHostSystemInfo::default(),
            ));
        }
        let install_dir = resolve_process_install_dir()?;
        Self::from_install_dir(config, install_dir)
    }

    pub fn from_install_dir(
        config: GatewayConfig,
        install_dir: impl Into<PathBuf>,
    ) -> Result<Self, GatewayRuntimePortError> {
        if config.entry_mode == GatewayEntryMode::Embedded {
            return Err(GatewayRuntimePortError::new(
                "embedded Gateway system info requires explicit host information",
            ));
        }
        Ok(Self {
            config,
            source: GatewaySystemInfoSource::InstallMeta {
                install_dir: install_dir.into(),
                fallback_platform: current_typescript_platform(),
            },
        })
    }

    pub fn with_host_info(config: GatewayConfig, host: GatewayHostSystemInfo) -> Self {
        Self {
            config,
            source: GatewaySystemInfoSource::Host(host),
        }
    }

    async fn resolve_install_info(&self) -> ResolvedInstallInfo {
        if !self.config.is_prod() {
            let base_version = match &self.source {
                GatewaySystemInfoSource::Host(host) => &host.base_version,
                GatewaySystemInfoSource::InstallMeta { .. } => GATEWAY_VERSION,
            };
            return ResolvedInstallInfo::not_installed(base_version);
        }
        match &self.source {
            GatewaySystemInfoSource::Host(host) => ResolvedInstallInfo::from_host(host),
            GatewaySystemInfoSource::InstallMeta {
                install_dir,
                fallback_platform,
            } => read_install_meta(install_dir, fallback_platform)
                .await
                .unwrap_or_else(|| ResolvedInstallInfo::not_installed(GATEWAY_VERSION)),
        }
    }
}

#[async_trait]
impl GatewaySystemInfoProvider for ProductionGatewaySystemInfoProvider {
    async fn system_info(&self) -> Result<SystemInfo, GatewayRuntimePortError> {
        let install = self.resolve_install_info().await;
        let is_prod = self.config.is_prod();
        let managed = self.config.management_mode != ManagementMode::None
            || self.config.update_owner != UpdateOwner::SelfManaged;
        let can_self_update = is_prod
            && install.installed_via_cli
            && install.deployment != GatewayDeployment::None
            && !managed;
        let base_version = normalized_version(&install.base_version).to_owned();
        Ok(SystemInfo {
            version: if is_prod {
                base_version.clone()
            } else {
                format!("{base_version}_dev")
            },
            base_version,
            is_prod,
            installed_via_cli: install.installed_via_cli,
            deployment: install.deployment.as_str().to_owned(),
            can_self_update,
            service_name: install.service_name,
            transfer_max_bytes: self.config.transfer_max_bytes,
            terminal_paste_max_bytes: TERMINAL_PASTE_MAX_BYTES as u64,
            paste_image_max_bytes: PASTE_IMAGE_MAX_BYTES,
            management_mode: management_mode(self.config.management_mode).to_owned(),
            update_owner: update_owner(self.config.update_owner).to_owned(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMeta {
    service_name: Option<String>,
    platform: Option<String>,
}

struct ResolvedInstallInfo {
    base_version: String,
    installed_via_cli: bool,
    deployment: GatewayDeployment,
    service_name: Option<String>,
}

impl ResolvedInstallInfo {
    fn not_installed(base_version: &str) -> Self {
        Self {
            base_version: base_version.to_owned(),
            installed_via_cli: false,
            deployment: GatewayDeployment::None,
            service_name: None,
        }
    }

    fn from_host(host: &GatewayHostSystemInfo) -> Self {
        if !host.installed_via_cli {
            return Self::not_installed(&host.base_version);
        }
        Self {
            base_version: host.base_version.clone(),
            installed_via_cli: true,
            deployment: host.deployment,
            service_name: host.service_name.clone(),
        }
    }
}

async fn read_install_meta(
    install_dir: &Path,
    fallback_platform: &str,
) -> Option<ResolvedInstallInfo> {
    let contents = tokio::fs::read_to_string(install_dir.join("install-meta.json"))
        .await
        .ok()?;
    let metadata = serde_json::from_str::<InstallMeta>(&contents).ok()?;
    let platform = metadata.platform.as_deref().unwrap_or(fallback_platform);
    Some(ResolvedInstallInfo {
        base_version: GATEWAY_VERSION.to_owned(),
        installed_via_cli: true,
        deployment: GatewayDeployment::from_platform(platform),
        service_name: metadata.service_name,
    })
}

fn resolve_process_install_dir() -> Result<PathBuf, GatewayRuntimePortError> {
    if let Some(fe_dist) = std::env::var_os("TMEX_FE_DIST_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(fe_dist).join("..").join(".."));
    }
    std::env::current_dir().map_err(|error| {
        GatewayRuntimePortError::new(format!(
            "failed to resolve Gateway installation directory: {error}"
        ))
    })
}

fn current_typescript_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

fn normalized_version(version: &str) -> &str {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        "unknown"
    } else {
        trimmed
    }
}

fn management_mode(mode: ManagementMode) -> &'static str {
    match mode {
        ManagementMode::None => "none",
        ManagementMode::App => "app",
        ManagementMode::CompanionCli => "companion-cli",
    }
}

fn update_owner(owner: UpdateOwner) -> &'static str {
    match owner {
        UpdateOwner::SelfManaged => "self",
        UpdateOwner::App => "app",
        UpdateOwner::Companion => "companion",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::config::{GatewayEntryMode, GatewayPlatform};

    use super::*;

    fn config(entry_mode: GatewayEntryMode, production: bool) -> GatewayConfig {
        let mut env = HashMap::from([(
            "NODE_ENV".to_owned(),
            if production { "production" } else { "test" }.to_owned(),
        )]);
        if production {
            env.insert(
                "TMEX_MASTER_KEY".to_owned(),
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            );
        }
        GatewayConfig::from_env(entry_mode, GatewayPlatform::Posix, &env, None)
            .expect("build system-info test config")
    }

    #[tokio::test]
    async fn install_metadata_and_entry_modes_preserve_update_safety() {
        let directory = tempfile::tempdir().expect("create install metadata directory");
        tokio::fs::write(
            directory.path().join("install-meta.json"),
            r#"{"serviceName":"tmex-dev","platform":"darwin"}"#,
        )
        .await
        .expect("write install metadata");
        let standalone = ProductionGatewaySystemInfoProvider::from_install_dir(
            config(GatewayEntryMode::Repository, true),
            directory.path(),
        )
        .expect("create standalone system info");
        let info = standalone.system_info().await.expect("standalone info");
        assert!(info.is_prod);
        assert!(info.installed_via_cli);
        assert_eq!(info.deployment, "launchd");
        assert_eq!(info.service_name.as_deref(), Some("tmex-dev"));
        assert!(info.can_self_update);
        assert_eq!(info.management_mode, "none");
        assert_eq!(info.update_owner, "self");

        let embedded_config = config(GatewayEntryMode::Embedded, true);
        assert!(ProductionGatewaySystemInfoProvider::from_install_dir(
            embedded_config.clone(),
            directory.path(),
        )
        .is_err());
        let embedded = ProductionGatewaySystemInfoProvider::with_host_info(
            embedded_config,
            GatewayHostSystemInfo {
                base_version: "2.0.0-host".to_owned(),
                installed_via_cli: true,
                deployment: GatewayDeployment::Launchd,
                service_name: Some("vibex".to_owned()),
            },
        );
        let info = embedded.system_info().await.expect("embedded info");
        assert_eq!(info.version, "2.0.0-host");
        assert_eq!(info.base_version, "2.0.0-host");
        assert_eq!(info.deployment, "launchd");
        assert_eq!(info.service_name.as_deref(), Some("vibex"));
        assert!(!info.can_self_update);
        assert_eq!(info.management_mode, "companion-cli");
        assert_eq!(info.update_owner, "companion");
    }

    #[tokio::test]
    async fn malformed_or_nonproduction_install_metadata_is_not_a_cli_install() {
        let directory = tempfile::tempdir().expect("create install metadata directory");
        tokio::fs::write(directory.path().join("install-meta.json"), b"not-json")
            .await
            .expect("write invalid install metadata");
        let malformed = ProductionGatewaySystemInfoProvider::from_install_dir(
            config(GatewayEntryMode::Repository, true),
            directory.path(),
        )
        .expect("create malformed metadata provider")
        .system_info()
        .await
        .expect("malformed metadata info");
        assert!(!malformed.installed_via_cli);
        assert_eq!(malformed.deployment, "none");
        assert_eq!(malformed.service_name, None);
        assert!(!malformed.can_self_update);

        tokio::fs::write(directory.path().join("install-meta.json"), r#"{}"#)
            .await
            .expect("write install metadata");
        let development = ProductionGatewaySystemInfoProvider::from_install_dir(
            config(GatewayEntryMode::Repository, false),
            directory.path(),
        )
        .expect("create development provider")
        .system_info()
        .await
        .expect("development info");
        assert!(!development.is_prod);
        assert!(development.version.ends_with("_dev"));
        assert!(!development.installed_via_cli);
        assert_eq!(development.deployment, "none");
    }
}
