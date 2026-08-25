mod cancel;
mod categorize;
mod path;
mod queue;
mod rsync;
mod runtime;
mod service;
mod system_runtime;
mod transfer;
mod types;

pub use cancel::FileCancellation;
pub use categorize::{categorize, mime_of, MAX_ENTRIES, MAX_TEXT_BYTES};
pub use path::{check_and_normalize, posix_basename, posix_join, sanitize_upload_name};
pub use rsync::{
    classify_rsync_failure, parse_list_only, parse_rsync_progress, rsync_copy_args,
    rsync_list_args, rsync_upload_args,
};
pub use runtime::{
    FileRuntime, FileRuntimeError, PreparedRsyncDevice, RsyncRequest, RsyncResult, RsyncTimeout,
};
pub use service::{FileService, PulledFile};
pub use system_runtime::SystemFileRuntime;
pub use transfer::{AppendUploadError, DownloadSession, TransferManager, UploadCommit};
pub use types::{
    FileCategory, FileContentResponse, FileEntry, FileEntryType, FileError, FileErrorCode,
    FileResult, FileStatResponse, ListFilesResponse, RsyncEntry, RsyncProgress,
};

pub const UPLOAD_CHUNK_SIZE: usize = 8 * 1024 * 1024;
pub const UPLOAD_CHUNK_BODY_LIMIT: usize = 128 * 1024 * 1024;
pub const PASTE_IMAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const RAW_MAX_BYTES: u64 = 50 * 1024 * 1024;
