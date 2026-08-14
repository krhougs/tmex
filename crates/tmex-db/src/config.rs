use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_COMMAND_CAPACITY: usize = 64;
pub const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct DbConfig {
    pub(crate) path: PathBuf,
    pub(crate) command_capacity: usize,
    pub(crate) busy_timeout: Duration,
}

impl DbConfig {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            command_capacity: DEFAULT_COMMAND_CAPACITY,
            busy_timeout: DEFAULT_BUSY_TIMEOUT,
        }
    }

    pub fn in_memory() -> Self {
        Self::new(":memory:")
    }

    pub fn command_capacity(mut self, capacity: usize) -> Self {
        self.command_capacity = capacity;
        self
    }

    pub fn busy_timeout(mut self, timeout: Duration) -> Self {
        self.busy_timeout = timeout;
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn configured_command_capacity(&self) -> usize {
        self.command_capacity
    }

    pub fn configured_busy_timeout(&self) -> Duration {
        self.busy_timeout
    }
}
