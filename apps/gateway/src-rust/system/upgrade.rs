use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;

const BUN_ADD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpgradeState {
    Idle,
    Downloading,
    Executing,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeStatus {
    pub state: UpgradeState,
    pub target_version: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
}

impl Default for UpgradeStatus {
    fn default() -> Self {
        Self {
            state: UpgradeState::Idle,
            target_version: None,
            error: None,
            started_at: None,
        }
    }
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{0}")]
pub struct UpgradeRunError(pub String);

#[async_trait]
pub trait UpgradeRunner: Send + Sync {
    async fn download_and_execute(&self, version: &str) -> Result<(), UpgradeRunError>;
}

pub struct UpgradeController {
    status: Mutex<UpgradeStatus>,
    runner: Arc<dyn UpgradeRunner>,
}

impl UpgradeController {
    pub fn new(runner: Arc<dyn UpgradeRunner>) -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(UpgradeStatus::default()),
            runner,
        })
    }

    pub fn production() -> Arc<Self> {
        Self::new(Arc::new(ProductionUpgradeRunner))
    }

    pub fn status(&self) -> UpgradeStatus {
        match self.status.lock() {
            Ok(status) => status.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub fn start(self: &Arc<Self>, version: String) -> bool {
        {
            let mut status = match self.status.lock() {
                Ok(status) => status,
                Err(poisoned) => poisoned.into_inner(),
            };
            if status.state != UpgradeState::Idle {
                return false;
            }
            *status = UpgradeStatus {
                state: UpgradeState::Downloading,
                target_version: Some(version.clone()),
                error: None,
                started_at: Some(current_timestamp()),
            };
        }
        let controller = Arc::clone(self);
        tokio::spawn(async move {
            controller.run(version).await;
        });
        true
    }

    async fn run(&self, version: String) {
        match self.runner.download_and_execute(&version).await {
            Ok(()) => {
                let mut status = match self.status.lock() {
                    Ok(status) => status,
                    Err(poisoned) => poisoned.into_inner(),
                };
                status.state = UpgradeState::Executing;
            }
            Err(error) => {
                let mut status = match self.status.lock() {
                    Ok(status) => status,
                    Err(poisoned) => poisoned.into_inner(),
                };
                status.state = UpgradeState::Idle;
                status.target_version = None;
                status.error = Some(error.0);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProductionUpgradeRunner;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMeta {
    install_dir: Option<String>,
    bun_path: Option<String>,
}

#[async_trait]
impl UpgradeRunner for ProductionUpgradeRunner {
    async fn download_and_execute(&self, version: &str) -> Result<(), UpgradeRunError> {
        let install = resolve_install_layout()?;
        let bun = resolve_bun(install.bun_path.as_deref())?;
        let stage = tempfile::Builder::new()
            .prefix("tmex-upg-")
            .tempdir()
            .map_err(|error| UpgradeRunError(error.to_string()))?;
        let cache = tempfile::Builder::new()
            .prefix("tmex-upg-cache-")
            .tempdir()
            .map_err(|error| UpgradeRunError(error.to_string()))?;
        write_stage_package(stage.path())?;
        run_bun_add(stage.path(), cache.path(), &bun, version).await?;
        let bin_path = stage
            .path()
            .join("node_modules")
            .join("tmex-cli")
            .join("bin")
            .join("tmex.js");
        if !bin_path.is_file() {
            return Err(UpgradeRunError(format!(
                "downloaded tmex-cli binary not found at {}",
                bin_path.display()
            )));
        }
        spawn_detached_upgrade(&bun, &bin_path, &install.install_dir, version)?;
        // The detached CLI process stops this Gateway. Leak the stage directories so
        // they remain readable until the child finishes, matching the TypeScript
        // controller.
        std::mem::forget(stage);
        std::mem::forget(cache);
        Ok(())
    }
}

struct ResolvedInstall {
    install_dir: PathBuf,
    bun_path: Option<PathBuf>,
}

fn resolve_install_layout() -> Result<ResolvedInstall, UpgradeRunError> {
    let fallback = resolve_install_dir()?;
    let meta_path = fallback.join("install-meta.json");
    let meta = read_install_meta(&meta_path)?;
    let install_dir = meta
        .as_ref()
        .and_then(|meta| meta.install_dir.as_deref())
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(fallback);
    let bun_path = meta
        .as_ref()
        .and_then(|meta| meta.bun_path.as_deref())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(ResolvedInstall {
        install_dir,
        bun_path,
    })
}

fn resolve_install_dir() -> Result<PathBuf, UpgradeRunError> {
    if let Some(fe_dist) = std::env::var_os("TMEX_FE_DIST_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(fe_dist).join("..").join(".."));
    }
    std::env::current_dir().map_err(|error| {
        UpgradeRunError(format!("install directory could not be resolved: {error}"))
    })
}

fn read_install_meta(path: &Path) -> Result<Option<InstallMeta>, UpgradeRunError> {
    if !path.is_file() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path).map_err(|error| {
        UpgradeRunError(format!(
            "failed to read install metadata {}: {error}",
            path.display()
        ))
    })?;
    serde_json::from_str(&contents).map(Some).map_err(|error| {
        UpgradeRunError(format!(
            "failed to parse install metadata {}: {error}",
            path.display()
        ))
    })
}

fn write_stage_package(stage: &Path) -> Result<(), UpgradeRunError> {
    fs::write(
        stage.join("package.json"),
        b"{\"name\":\"tmex-upgrade-stage\",\"private\":true}\n",
    )
    .map_err(|error| UpgradeRunError(error.to_string()))
}

async fn run_bun_add(
    stage: &Path,
    cache: &Path,
    bun: &Path,
    version: &str,
) -> Result<(), UpgradeRunError> {
    let mut command = Command::new(bun);
    command
        .arg("add")
        .arg(format!("tmex-cli@{version}"))
        .current_dir(stage)
        .env("BUN_INSTALL_CACHE_DIR", cache)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(BUN_ADD_TIMEOUT, command.status())
        .await
        .map_err(|_| UpgradeRunError(format!("bun add tmex-cli@{version} timed out")))?
        .map_err(|error| UpgradeRunError(error.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(UpgradeRunError(format!(
            "bun add tmex-cli@{version} exited with code {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".to_owned())
        )))
    }
}

fn spawn_detached_upgrade(
    bun: &Path,
    bin_path: &Path,
    install_dir: &Path,
    version: &str,
) -> Result<(), UpgradeRunError> {
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(install_dir.join("upgrade.log"))
        .ok();
    let (stdout, stderr) = match log_file {
        Some(file) => match file.try_clone() {
            Ok(cloned) => (Stdio::from(file), Stdio::from(cloned)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        None => (Stdio::null(), Stdio::null()),
    };
    let mut command = std::process::Command::new(bun);
    command
        .arg(bin_path)
        .arg("upgrade")
        .arg("--apply-current-package")
        .arg("--install-dir")
        .arg(install_dir)
        .arg("--version")
        .arg(version)
        .arg("--bun-path")
        .arg(bun)
        .current_dir(install_dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    configure_detached_child(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| UpgradeRunError(error.to_string()))
}

fn configure_detached_child(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn resolve_bun(meta_bun_path: Option<&Path>) -> Result<PathBuf, UpgradeRunError> {
    if let Some(explicit) = std::env::var_os("TMEX_BUN_PATH").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(explicit);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(UpgradeRunError(format!(
            "TMEX_BUN_PATH is not an existing absolute path: {}",
            path.display()
        )));
    }
    let mut candidates = Vec::new();
    if let Some(meta) = meta_bun_path.filter(|path| path.is_absolute()) {
        candidates.push(meta.to_path_buf());
    }
    candidates.push(PathBuf::from("bun"));
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".bun").join("bin").join("bun"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    candidates.push(PathBuf::from("/usr/local/bin/bun"));
    candidates.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/bun"));

    let mut first_error = None;
    for candidate in candidates {
        if candidate != Path::new("bun") && !candidate.is_file() {
            continue;
        }
        match probe_bun(&candidate) {
            Ok(path) => return Ok(path),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    Err(first_error.unwrap_or_else(|| UpgradeRunError("bun was not found".to_owned())))
}

fn probe_bun(candidate: &Path) -> Result<PathBuf, UpgradeRunError> {
    let output = std::process::Command::new(candidate)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let output = match output {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(UpgradeRunError(format!(
                "bun was not found at {}",
                candidate.display()
            )));
        }
        Err(error) => return Err(UpgradeRunError(error.to_string())),
    };
    if !output.status.success() {
        return Err(UpgradeRunError(format!(
            "failed to execute bun --version at {}",
            candidate.display()
        )));
    }
    Ok(candidate.to_path_buf())
}

fn current_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{UpgradeController, UpgradeRunError, UpgradeRunner, UpgradeState};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    struct ScriptedRunner {
        delay: Arc<Notify>,
        calls: AtomicUsize,
        fail: bool,
    }

    #[async_trait]
    impl UpgradeRunner for ScriptedRunner {
        async fn download_and_execute(&self, _version: &str) -> Result<(), UpgradeRunError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.delay.notified().await;
            if self.fail {
                Err(UpgradeRunError("download failed".to_owned()))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn start_rejects_concurrent_upgrades_and_records_download_failure() {
        let delay = Arc::new(Notify::new());
        let runner = Arc::new(ScriptedRunner {
            delay: delay.clone(),
            calls: AtomicUsize::new(0),
            fail: true,
        });
        let controller = UpgradeController::new(runner.clone());
        assert!(controller.start("1.2.3".to_owned()));
        assert!(!controller.start("1.2.4".to_owned()));
        let busy = controller.status();
        assert_eq!(busy.state, UpgradeState::Downloading);
        assert_eq!(busy.target_version.as_deref(), Some("1.2.3"));
        delay.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if controller.status().state == UpgradeState::Idle {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("upgrade returned to idle");
        let failed = controller.status();
        assert_eq!(failed.state, UpgradeState::Idle);
        assert_eq!(failed.error.as_deref(), Some("download failed"));
        assert_eq!(failed.target_version, None);
        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        assert!(controller.start("1.2.5".to_owned()));
    }
}
