use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use tokio::sync::mpsc;

use crate::database::repository::Repository;
use crate::entity::{devices, file_roots};

use super::path::{check_and_normalize, posix_basename, posix_join, sanitize_upload_name};
use super::queue::DeviceQueue;
use super::rsync::{
    classify_rsync_failure, entries_to_response, parse_list_only, rsync_copy_args, rsync_list_args,
    rsync_upload_args,
};
use super::runtime::subprocess_environment;
use super::transfer::temporary_file;
use super::{
    categorize, mime_of, FileCancellation, FileCategory, FileContentResponse, FileEntryType,
    FileError, FileErrorCode, FileResult, FileRuntime, FileStatResponse, ListFilesResponse,
    PreparedRsyncDevice, RsyncEntry, RsyncProgress, RsyncRequest, RsyncResult, RsyncTimeout,
    TransferManager, MAX_ENTRIES, MAX_TEXT_BYTES,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const COPY_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSFER_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const GLOBAL_MAX_CONCURRENT: usize = 4;

pub struct PulledFile {
    pub path: PathBuf,
    pub size: u64,
    pub name: String,
    pub mime: Option<&'static str>,
    _directory: TempDir,
}

impl PulledFile {
    pub(crate) fn from_parts(
        path: PathBuf,
        size: u64,
        name: String,
        mime: Option<&'static str>,
        directory: TempDir,
    ) -> Self {
        Self {
            path,
            size,
            name,
            mime,
            _directory: directory,
        }
    }
}

#[derive(Clone)]
pub struct FileService {
    repository: Repository,
    runtime: Arc<dyn FileRuntime>,
    queue: DeviceQueue,
    transfers: TransferManager,
    transfer_max_bytes: u64,
}

struct OperationContext {
    root: file_roots::Model,
    device: devices::Model,
}

impl FileService {
    pub fn new(
        repository: Repository,
        runtime: Arc<dyn FileRuntime>,
        transfer_max_bytes: f64,
    ) -> Self {
        let transfer_max_bytes = if transfer_max_bytes.is_finite() && transfer_max_bytes >= 0.0 {
            transfer_max_bytes.min(u64::MAX as f64) as u64
        } else {
            0
        };
        Self {
            repository,
            runtime,
            queue: DeviceQueue::new(GLOBAL_MAX_CONCURRENT),
            transfers: TransferManager::new(),
            transfer_max_bytes,
        }
    }

    pub fn transfers(&self) -> &TransferManager {
        &self.transfers
    }

    pub async fn list_directory(
        &self,
        root_id: &str,
        input_path: Option<&str>,
    ) -> FileResult<ListFilesResponse> {
        let context = self.resolve_context(root_id).await?;
        let normalized = check_and_normalize(
            &context.device.r#type,
            &context.root.path,
            input_path.unwrap_or(&context.root.path),
        )
        .await?;
        let device_id = context.device.id.clone();
        let this = self.clone();
        self.queue
            .run(&device_id, async move {
                let spec = this.prepare(&context.device).await?;
                let list_path = if normalized.ends_with('/') {
                    normalized.clone()
                } else {
                    format!("{normalized}/")
                };
                let result = this
                    .run(
                        &spec,
                        rsync_list_args(&spec, &list_path),
                        RsyncTimeout::Fixed(LIST_TIMEOUT),
                        FileCancellation::new(),
                        None,
                    )
                    .await?;
                let parsed = successful_list(result)?;
                let truncated = parsed.len() > MAX_ENTRIES;
                let entries = entries_to_response(
                    parsed.into_iter().take(MAX_ENTRIES).collect(),
                    &normalized,
                );
                Ok(ListFilesResponse {
                    path: normalized,
                    entries,
                    truncated,
                })
            })
            .await
    }

    pub async fn stat_file(&self, root_id: &str, input_path: &str) -> FileResult<FileStatResponse> {
        let context = self.resolve_context(root_id).await?;
        let normalized =
            check_and_normalize(&context.device.r#type, &context.root.path, input_path).await?;
        let device_id = context.device.id.clone();
        let this = self.clone();
        self.queue
            .run(&device_id, async move {
                let spec = this.prepare(&context.device).await?;
                let entry = this
                    .stat_with_spec(&spec, &normalized, FileCancellation::new())
                    .await?;
                Ok(stat_response(&normalized, entry))
            })
            .await
    }

    pub async fn read_text_file(
        &self,
        root_id: &str,
        input_path: &str,
    ) -> FileResult<FileContentResponse> {
        let context = self.resolve_context(root_id).await?;
        let normalized =
            check_and_normalize(&context.device.r#type, &context.root.path, input_path).await?;
        let device_id = context.device.id.clone();
        let this = self.clone();
        self.queue
            .run(&device_id, async move {
                let spec = this.prepare(&context.device).await?;
                let entry = this
                    .stat_with_spec(&spec, &normalized, FileCancellation::new())
                    .await?;
                if entry.entry_type == FileEntryType::Dir {
                    return Err(FileError::code(FileErrorCode::IsDirectory));
                }
                if entry.size.is_some_and(|size| size > MAX_TEXT_BYTES) {
                    return Err(FileError::code(FileErrorCode::TooLarge));
                }
                let file = this
                    .copy_to_temp(
                        &spec,
                        &normalized,
                        "tmex-rfile-",
                        RsyncTimeout::Fixed(COPY_TIMEOUT),
                        FileCancellation::new(),
                        None,
                    )
                    .await?;
                let bytes = tokio::fs::read(&file.path).await.map_err(|error| {
                    FileError::detailed(FileErrorCode::Unknown, error.to_string())
                })?;
                if bytes.len() as u64 > MAX_TEXT_BYTES {
                    return Err(FileError::code(FileErrorCode::TooLarge));
                }
                if bytes.iter().take(8_192).any(|byte| *byte == 0) {
                    return Err(FileError::code(FileErrorCode::Binary));
                }
                let name = posix_basename(&normalized);
                Ok(FileContentResponse {
                    path: normalized,
                    name: name.clone(),
                    category: categorize(&name),
                    encoding: "utf-8",
                    content: String::from_utf8_lossy(&bytes).into_owned(),
                    size: entry.size.unwrap_or(bytes.len() as u64),
                    truncated: false,
                })
            })
            .await
    }

    pub async fn pull_file(
        &self,
        root_id: &str,
        input_path: &str,
        maximum_bytes: Option<u64>,
        cancellation: FileCancellation,
        progress: Option<mpsc::Sender<RsyncProgress>>,
    ) -> FileResult<PulledFile> {
        let context = self.resolve_context(root_id).await?;
        let normalized =
            check_and_normalize(&context.device.r#type, &context.root.path, input_path).await?;
        let maximum_bytes = maximum_bytes.unwrap_or(self.transfer_max_bytes);
        let device_id = context.device.id.clone();
        let this = self.clone();
        self.queue
            .run(&device_id, async move {
                let spec = this.prepare(&context.device).await?;
                let entry = this
                    .stat_with_spec(&spec, &normalized, cancellation.clone())
                    .await?;
                if entry.entry_type == FileEntryType::Dir {
                    return Err(FileError::code(FileErrorCode::IsDirectory));
                }
                if entry.size.is_some_and(|size| size > maximum_bytes) {
                    return Err(FileError::code(FileErrorCode::TooLarge));
                }
                let timeout = if progress.is_some() {
                    RsyncTimeout::Idle(TRANSFER_IDLE_TIMEOUT)
                } else {
                    RsyncTimeout::Fixed(COPY_TIMEOUT)
                };
                let mut file = this
                    .copy_to_temp(
                        &spec,
                        &normalized,
                        "tmex-dl-",
                        timeout,
                        cancellation,
                        progress,
                    )
                    .await?;
                file.size = tokio::fs::metadata(&file.path)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or_else(|_| entry.size.unwrap_or(0));
                if file.size > maximum_bytes {
                    return Err(FileError::code(FileErrorCode::TooLarge));
                }
                file.name = posix_basename(&normalized);
                file.mime = mime_of(&file.name);
                Ok(file)
            })
            .await
    }

    pub async fn push_file(
        &self,
        root_id: &str,
        destination_directory: &str,
        source: &Path,
        name: &str,
        cancellation: FileCancellation,
        progress: Option<mpsc::Sender<RsyncProgress>>,
    ) -> FileResult<String> {
        let name =
            sanitize_upload_name(name).ok_or_else(|| FileError::code(FileErrorCode::Invalid))?;
        let context = self.resolve_context(root_id).await?;
        let normalized = check_and_normalize(
            &context.device.r#type,
            &context.root.path,
            destination_directory,
        )
        .await?;
        let source = source
            .to_str()
            .ok_or_else(|| FileError::code(FileErrorCode::Invalid))?
            .to_owned();
        let device_id = context.device.id.clone();
        let this = self.clone();
        self.queue
            .run(&device_id, async move {
                let spec = this.prepare(&context.device).await?;
                let entry = this
                    .stat_with_spec(&spec, &normalized, cancellation.clone())
                    .await?;
                if entry.entry_type != FileEntryType::Dir {
                    return Err(FileError::code(FileErrorCode::NotADirectory));
                }
                let destination = posix_join(&normalized, &name);
                let result = this
                    .run(
                        &spec,
                        rsync_upload_args(&spec, &source, &destination),
                        RsyncTimeout::Idle(TRANSFER_IDLE_TIMEOUT),
                        cancellation,
                        progress,
                    )
                    .await?;
                successful(result)?;
                Ok(name)
            })
            .await
    }

    async fn resolve_context(&self, root_id: &str) -> FileResult<OperationContext> {
        let root = self
            .repository
            .get_file_root_by_id(root_id)
            .await
            .map_err(repository_error)?
            .ok_or_else(|| FileError::code(FileErrorCode::RootNotFound))?;
        if root.enabled == 0 {
            return Err(FileError::code(FileErrorCode::RootDisabled));
        }
        let device = self
            .repository
            .get_device_by_id(&root.device_id)
            .await
            .map_err(repository_error)?
            .ok_or_else(|| FileError::code(FileErrorCode::DeviceNotFound))?;
        Ok(OperationContext { root, device })
    }

    async fn prepare(&self, device: &devices::Model) -> FileResult<PreparedRsyncDevice> {
        self.runtime
            .prepare_rsync(device)
            .await
            .map_err(|error| FileError::detailed(error.code, error.message))
    }

    async fn stat_with_spec(
        &self,
        spec: &PreparedRsyncDevice,
        normalized: &str,
        cancellation: FileCancellation,
    ) -> FileResult<RsyncEntry> {
        let result = self
            .run(
                spec,
                rsync_list_args(spec, normalized),
                RsyncTimeout::Fixed(LIST_TIMEOUT),
                cancellation,
                None,
            )
            .await?;
        successful_list(result)?
            .into_iter()
            .next()
            .ok_or_else(|| FileError::code(FileErrorCode::NotFound))
    }

    async fn copy_to_temp(
        &self,
        spec: &PreparedRsyncDevice,
        normalized: &str,
        prefix: &str,
        timeout: RsyncTimeout,
        cancellation: FileCancellation,
        progress: Option<mpsc::Sender<RsyncProgress>>,
    ) -> FileResult<PulledFile> {
        let (directory, path) = temporary_file(prefix)?;
        let destination = path
            .to_str()
            .ok_or_else(|| FileError::code(FileErrorCode::Invalid))?;
        let result = self
            .run(
                spec,
                rsync_copy_args(spec, normalized, destination),
                timeout,
                cancellation,
                progress,
            )
            .await?;
        successful(result)?;
        Ok(PulledFile::from_parts(
            path,
            0,
            String::new(),
            None,
            directory,
        ))
    }

    async fn run(
        &self,
        spec: &PreparedRsyncDevice,
        argv: Vec<String>,
        timeout: RsyncTimeout,
        cancellation: FileCancellation,
        progress: Option<mpsc::Sender<RsyncProgress>>,
    ) -> FileResult<RsyncResult> {
        self.runtime
            .run_rsync(RsyncRequest {
                argv,
                env: subprocess_environment(&spec.env),
                timeout,
                cancellation,
                progress,
            })
            .await
            .map_err(|error| FileError::detailed(error.code, error.message))
    }
}

fn successful(result: RsyncResult) -> FileResult<RsyncResult> {
    if result.exit_code == 0 {
        Ok(result)
    } else {
        Err(FileError::detailed(
            classify_rsync_failure(result.exit_code, &result.stderr),
            result.stderr,
        ))
    }
}

fn successful_list(result: RsyncResult) -> FileResult<Vec<RsyncEntry>> {
    successful(result).map(|result| parse_list_only(&result.stdout))
}

fn stat_response(path: &str, entry: RsyncEntry) -> FileStatResponse {
    let name = posix_basename(path);
    let is_directory = entry.entry_type == FileEntryType::Dir;
    let entry_type = if is_directory {
        FileEntryType::Dir
    } else if entry.entry_type == FileEntryType::Symlink {
        FileEntryType::Symlink
    } else {
        FileEntryType::File
    };
    FileStatResponse {
        path: path.to_owned(),
        name: name.clone(),
        entry_type,
        category: if is_directory {
            FileCategory::Directory
        } else {
            categorize(&name)
        },
        size: if is_directory {
            0
        } else {
            entry.size.unwrap_or(0)
        },
        modified_at: entry.modified_at,
        mime: (!is_directory).then(|| mime_of(&name)).flatten(),
        is_symlink: entry.entry_type == FileEntryType::Symlink,
    }
}

fn repository_error(error: impl std::fmt::Display) -> FileError {
    FileError::detailed(FileErrorCode::Unknown, error.to_string())
}
