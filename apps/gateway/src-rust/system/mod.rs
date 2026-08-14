pub mod semver;
pub mod update_check;
pub mod upgrade;

pub use semver::compare_versions;
pub use update_check::{
    check_for_update, RegistryPackument, UpdateCheckError, UpdateCheckResult, UpdateRegistry,
    UpdateRegistryError,
};
pub use upgrade::{UpgradeController, UpgradeRunError, UpgradeRunner, UpgradeState, UpgradeStatus};
