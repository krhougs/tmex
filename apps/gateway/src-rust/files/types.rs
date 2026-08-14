use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileErrorCode {
    Invalid,
    OutsideRoots,
    NotFound,
    NotADirectory,
    IsDirectory,
    TooLarge,
    Binary,
    PermissionDenied,
    DeviceNotFound,
    RootNotFound,
    RootDisabled,
    ConnectionFailed,
    AuthUnsupported,
    RsyncMissingLocal,
    RsyncMissingRemote,
    Timeout,
    Unknown,
}

impl FileErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::OutsideRoots => "outside_roots",
            Self::NotFound => "not_found",
            Self::NotADirectory => "not_a_directory",
            Self::IsDirectory => "is_directory",
            Self::TooLarge => "too_large",
            Self::Binary => "binary",
            Self::PermissionDenied => "permission_denied",
            Self::DeviceNotFound => "device_not_found",
            Self::RootNotFound => "root_not_found",
            Self::RootDisabled => "root_disabled",
            Self::ConnectionFailed => "connection_failed",
            Self::AuthUnsupported => "auth_unsupported",
            Self::RsyncMissingLocal => "rsync_missing_local",
            Self::RsyncMissingRemote => "rsync_missing_remote",
            Self::Timeout => "timeout",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{code:?}{detail_suffix}", detail_suffix = detail.as_deref().map(|v| format!(": {v}")).unwrap_or_default())]
pub struct FileError {
    pub code: FileErrorCode,
    pub detail: Option<String>,
}

impl FileError {
    pub const fn code(code: FileErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn detailed(code: FileErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

pub type FileResult<T> = Result<T, FileError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileCategory {
    Directory,
    Code,
    Markdown,
    Image,
    Pdf,
    Text,
    Archive,
    Audio,
    Video,
    Binary,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEntryType {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RsyncEntry {
    pub name: String,
    pub entry_type: FileEntryType,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsyncProgress {
    pub transferred: u64,
    pub pct: u8,
    pub rate: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: FileEntryType,
    pub category: FileCategory,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    pub is_symlink: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesResponse {
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResponse {
    pub path: String,
    pub name: String,
    pub category: FileCategory,
    pub encoding: &'static str,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatResponse {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: FileEntryType,
    pub category: FileCategory,
    pub size: u64,
    pub modified_at: Option<String>,
    pub mime: Option<&'static str>,
    pub is_symlink: bool,
}
