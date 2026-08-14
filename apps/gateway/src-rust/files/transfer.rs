use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime};

use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use super::{
    FileCancellation, FileError, FileErrorCode, FileResult, PulledFile, UPLOAD_CHUNK_SIZE,
};

const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const GC_INTERVAL: Duration = Duration::from_secs(5 * 60);
const ORPHAN_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const ORPHAN_PREFIXES: [&str; 2] = ["tmex-up-", "tmex-dl-"];

#[derive(Clone)]
pub struct TransferManager {
    inner: Arc<TransferInner>,
}

struct TransferInner {
    uploads: Mutex<HashMap<String, Arc<AsyncMutex<UploadSession>>>>,
    downloads: Mutex<HashMap<String, DownloadSession>>,
}

struct UploadSession {
    root_id: String,
    destination_directory: String,
    name: String,
    size: u64,
    received: u64,
    directory: TempDir,
    cancellation: FileCancellation,
    created_at: Instant,
    committing: bool,
}

pub struct UploadCommit {
    pub root_id: String,
    pub destination_directory: String,
    pub name: String,
    pub size: u64,
    pub path: PathBuf,
    pub cancellation: FileCancellation,
    _session: Arc<AsyncMutex<UploadSession>>,
}

pub struct DownloadSession {
    pub id: String,
    pub size: u64,
    pub name: String,
    pub mime: Option<&'static str>,
    pub file: PulledFile,
    created_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppendUploadError {
    NotFound,
    BadOffset,
    TooLarge,
    Committing,
    Io,
}

impl TransferManager {
    pub fn new() -> Self {
        sweep_orphan_transfer_temps();
        let inner = Arc::new(TransferInner {
            uploads: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
        });
        spawn_gc(Arc::downgrade(&inner));
        Self { inner }
    }

    pub async fn create_upload(
        &self,
        root_id: String,
        destination_directory: String,
        name: String,
        size: u64,
    ) -> FileResult<String> {
        self.sweep_stale();
        let directory = tempfile::Builder::new()
            .prefix("tmex-up-")
            .tempdir()
            .map_err(|error| FileError::detailed(FileErrorCode::Unknown, error.to_string()))?;
        tokio::fs::write(directory.path().join("f"), [])
            .await
            .map_err(|error| FileError::detailed(FileErrorCode::Unknown, error.to_string()))?;
        let id = Uuid::new_v4().to_string();
        let session = UploadSession {
            root_id,
            destination_directory,
            name,
            size,
            received: 0,
            directory,
            cancellation: FileCancellation::new(),
            created_at: Instant::now(),
            committing: false,
        };
        lock_recover(&self.inner.uploads).insert(id.clone(), Arc::new(AsyncMutex::new(session)));
        Ok(id)
    }

    pub async fn append_upload(
        &self,
        id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, AppendUploadError> {
        if bytes.len() > UPLOAD_CHUNK_SIZE {
            return Err(AppendUploadError::TooLarge);
        }
        let session = lock_recover(&self.inner.uploads).get(id).cloned();
        let Some(session) = session else {
            return Err(AppendUploadError::NotFound);
        };
        let mut session = session.lock().await;
        if session.committing {
            return Err(AppendUploadError::Committing);
        }
        if offset != session.received {
            return Err(AppendUploadError::BadOffset);
        }
        let received = session
            .received
            .checked_add(bytes.len() as u64)
            .ok_or(AppendUploadError::TooLarge)?;
        if received > session.size {
            return Err(AppendUploadError::TooLarge);
        }
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(session.directory.path().join("f"))
            .await
            .map_err(|_| AppendUploadError::Io)?;
        file.write_all(bytes)
            .await
            .map_err(|_| AppendUploadError::Io)?;
        file.flush().await.map_err(|_| AppendUploadError::Io)?;
        session.received = received;
        Ok(received)
    }

    pub async fn begin_upload_commit(&self, id: &str) -> FileResult<UploadCommit> {
        let session = lock_recover(&self.inner.uploads).get(id).cloned();
        let Some(session) = session else {
            return Err(FileError::code(FileErrorCode::NotFound));
        };
        let mut state = session.lock().await;
        if state.committing {
            return Err(FileError::detailed(
                FileErrorCode::Invalid,
                "upload is already committing",
            ));
        }
        if state.received != state.size {
            return Err(FileError::detailed(
                FileErrorCode::Invalid,
                "incomplete upload",
            ));
        }
        state.committing = true;
        let commit = UploadCommit {
            root_id: state.root_id.clone(),
            destination_directory: state.destination_directory.clone(),
            name: state.name.clone(),
            size: state.size,
            path: state.directory.path().join("f"),
            cancellation: state.cancellation.clone(),
            _session: Arc::clone(&session),
        };
        drop(state);
        Ok(commit)
    }

    pub fn remove_upload(&self, id: &str) {
        if let Some(session) = lock_recover(&self.inner.uploads).remove(id) {
            let cancellation = match session.try_lock() {
                Ok(session) => Some(session.cancellation.clone()),
                Err(_) => None,
            };
            if let Some(cancellation) = cancellation {
                cancellation.cancel();
            } else {
                let session = Arc::clone(&session);
                tokio::spawn(async move {
                    session.lock().await.cancellation.cancel();
                });
            }
        }
    }

    pub fn create_download(&self, file: PulledFile) -> (String, u64, String) {
        self.sweep_stale();
        let id = Uuid::new_v4().to_string();
        let size = file.size;
        let name = file.name.clone();
        let session = DownloadSession {
            id: id.clone(),
            size,
            name: name.clone(),
            mime: file.mime,
            file,
            created_at: Instant::now(),
        };
        lock_recover(&self.inner.downloads).insert(id.clone(), session);
        (id, size, name)
    }

    pub fn take_download(&self, id: &str) -> Option<DownloadSession> {
        lock_recover(&self.inner.downloads).remove(id)
    }

    pub fn remove_download(&self, id: &str) {
        lock_recover(&self.inner.downloads).remove(id);
    }

    fn sweep_stale(&self) {
        sweep_inner(&self.inner, Instant::now());
    }
}

impl Default for TransferManager {
    fn default() -> Self {
        Self::new()
    }
}

fn spawn_gc(inner: Weak<TransferInner>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(GC_INTERVAL);
        interval.tick().await;
        loop {
            interval.tick().await;
            let Some(inner) = inner.upgrade() else {
                return;
            };
            sweep_inner(&inner, Instant::now());
        }
    });
}

fn sweep_inner(inner: &TransferInner, now: Instant) {
    let stale_uploads = {
        let uploads = lock_recover(&inner.uploads);
        uploads
            .iter()
            .filter_map(|(id, session)| {
                session.try_lock().ok().and_then(|session| {
                    (!session.committing && now.duration_since(session.created_at) > SESSION_TTL)
                        .then(|| (id.clone(), session.cancellation.clone()))
                })
            })
            .collect::<Vec<_>>()
    };
    if !stale_uploads.is_empty() {
        let mut uploads = lock_recover(&inner.uploads);
        for (id, cancellation) in stale_uploads {
            cancellation.cancel();
            uploads.remove(&id);
        }
    }
    lock_recover(&inner.downloads)
        .retain(|_, session| now.duration_since(session.created_at) <= SESSION_TTL);
}

fn sweep_orphan_transfer_temps() {
    let temporary_directory = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(temporary_directory) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !ORPHAN_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > ORPHAN_MAX_AGE);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn temporary_file(prefix: &str) -> FileResult<(TempDir, PathBuf)> {
    let directory = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .map_err(|error| FileError::detailed(FileErrorCode::Unknown, error.to_string()))?;
    let path = directory.path().join(Path::new("f"));
    Ok((directory, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn upload_chunks_are_bounded_and_strictly_sequential() {
        let manager = TransferManager::new();
        let id = manager
            .create_upload("root".to_owned(), "/tmp".to_owned(), "f".to_owned(), 4)
            .await
            .expect("create session");
        assert_eq!(manager.append_upload(&id, 0, b"ab").await, Ok(2));
        assert_eq!(
            manager.append_upload(&id, 1, b"c").await,
            Err(AppendUploadError::BadOffset)
        );
        assert_eq!(manager.append_upload(&id, 2, b"cd").await, Ok(4));
        assert_eq!(
            manager
                .append_upload(&id, 4, &vec![0; UPLOAD_CHUNK_SIZE + 1])
                .await,
            Err(AppendUploadError::TooLarge)
        );
        manager
            .begin_upload_commit(&id)
            .await
            .expect("complete session commits");
        assert_eq!(
            manager.append_upload(&id, 4, b"").await,
            Err(AppendUploadError::Committing)
        );
    }
}
