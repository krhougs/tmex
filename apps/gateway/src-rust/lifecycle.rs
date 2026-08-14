use std::fmt;

use thiserror::Error;
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DatabasePhase {
    Opening,
    LegacyMigrations,
    OrmMigrations,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayState {
    Created,
    PreparingDatabase(DatabasePhase),
    Starting,
    Ready,
    Running,
    Draining,
    Stopped,
    Failed { stage: String, cause: String },
}

impl GatewayState {
    pub const fn is_terminal(&self) -> bool {
        matches!(self, Self::Stopped | Self::Failed { .. })
    }

    fn can_transition_to(&self, next: &Self) -> bool {
        match (self, next) {
            (Self::Created, Self::PreparingDatabase(_) | Self::Starting | Self::Draining) => true,
            (Self::PreparingDatabase(current), Self::PreparingDatabase(next)) => next > current,
            (Self::PreparingDatabase(_), Self::Starting | Self::Draining) => true,
            (Self::Starting, Self::Ready | Self::Draining) => true,
            (Self::Ready, Self::Running | Self::Draining) => true,
            (Self::Running, Self::Draining) => true,
            (Self::Draining, Self::Stopped) => true,
            (current, Self::Failed { .. }) => !current.is_terminal(),
            _ => false,
        }
    }
}

impl fmt::Display for GatewayState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Created => formatter.write_str("created"),
            Self::PreparingDatabase(phase) => write!(formatter, "preparing-database:{phase:?}"),
            Self::Starting => formatter.write_str("starting"),
            Self::Ready => formatter.write_str("ready"),
            Self::Running => formatter.write_str("running"),
            Self::Draining => formatter.write_str("draining"),
            Self::Stopped => formatter.write_str("stopped"),
            Self::Failed { stage, .. } => write!(formatter, "failed:{stage}"),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid Gateway lifecycle transition from {current} to {next}")]
pub struct LifecycleError {
    pub current: GatewayState,
    pub next: GatewayState,
}

pub struct LifecycleController {
    sender: watch::Sender<GatewayState>,
}

impl LifecycleController {
    pub fn new() -> (Self, watch::Receiver<GatewayState>) {
        let (sender, receiver) = watch::channel(GatewayState::Created);
        (Self { sender }, receiver)
    }

    pub fn state(&self) -> GatewayState {
        self.sender.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<GatewayState> {
        self.sender.subscribe()
    }

    pub fn transition(&self, next: GatewayState) -> Result<(), LifecycleError> {
        let current = self.state();
        if !current.can_transition_to(&next) {
            return Err(LifecycleError { current, next });
        }
        self.sender.send_replace(next);
        Ok(())
    }

    pub fn fail(
        &self,
        stage: impl Into<String>,
        cause: impl Into<String>,
    ) -> Result<(), LifecycleError> {
        self.transition(GatewayState::Failed {
            stage: stage.into(),
            cause: cause.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_is_monotonic_and_failure_is_terminal() {
        let (controller, receiver) = LifecycleController::new();
        controller
            .transition(GatewayState::PreparingDatabase(DatabasePhase::Opening))
            .expect("enter database preparation");
        controller
            .transition(GatewayState::PreparingDatabase(
                DatabasePhase::LegacyMigrations,
            ))
            .expect("advance database phase");
        controller
            .transition(GatewayState::Starting)
            .expect("start runtime");
        controller
            .transition(GatewayState::Ready)
            .expect("mark ready");
        controller
            .transition(GatewayState::Running)
            .expect("mark running");
        assert_eq!(*receiver.borrow(), GatewayState::Running);
        assert!(controller.transition(GatewayState::Ready).is_err());

        controller
            .fail("watch", "task exited")
            .expect("mark failed");
        assert!(controller.transition(GatewayState::Draining).is_err());
        assert!(controller.state().is_terminal());
    }

    #[test]
    fn orderly_shutdown_reaches_stopped() {
        let (controller, _) = LifecycleController::new();
        controller
            .transition(GatewayState::Draining)
            .expect("drain before startup");
        controller
            .transition(GatewayState::Stopped)
            .expect("stop after drain");
    }
}
