#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotRefreshAction {
    Start { cycle: u64 },
    Coalesced { cycle: u64 },
    StartTrailing { cycle: u64 },
    Idle { cycle: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotRefreshRunResult {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SnapshotRefreshCoordinator {
    active_cycle: Option<u64>,
    next_cycle: u64,
    trailing_requested: bool,
}

impl SnapshotRefreshCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request(&mut self) -> SnapshotRefreshAction {
        if let Some(cycle) = self.active_cycle {
            self.trailing_requested = true;
            return SnapshotRefreshAction::Coalesced { cycle };
        }
        let cycle = self.next_cycle;
        self.next_cycle = self.next_cycle.wrapping_add(1);
        self.active_cycle = Some(cycle);
        self.trailing_requested = false;
        SnapshotRefreshAction::Start { cycle }
    }

    pub fn complete_run(&mut self, result: SnapshotRefreshRunResult) -> SnapshotRefreshAction {
        let Some(cycle) = self.active_cycle else {
            return SnapshotRefreshAction::Idle {
                cycle: self.next_cycle,
            };
        };
        if result == SnapshotRefreshRunResult::Succeeded && self.trailing_requested {
            self.trailing_requested = false;
            return SnapshotRefreshAction::StartTrailing { cycle };
        }
        self.active_cycle = None;
        self.trailing_requested = false;
        SnapshotRefreshAction::Idle { cycle }
    }

    pub fn active_cycle(&self) -> Option<u64> {
        self.active_cycle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_in_flight_requests_into_exactly_one_trailing_run() {
        let mut coordinator = SnapshotRefreshCoordinator::new();
        assert_eq!(
            coordinator.request(),
            SnapshotRefreshAction::Start { cycle: 0 }
        );
        assert_eq!(
            coordinator.request(),
            SnapshotRefreshAction::Coalesced { cycle: 0 }
        );
        assert_eq!(
            coordinator.request(),
            SnapshotRefreshAction::Coalesced { cycle: 0 }
        );
        assert_eq!(
            coordinator.complete_run(SnapshotRefreshRunResult::Succeeded),
            SnapshotRefreshAction::StartTrailing { cycle: 0 }
        );
        assert_eq!(
            coordinator.complete_run(SnapshotRefreshRunResult::Succeeded),
            SnapshotRefreshAction::Idle { cycle: 0 }
        );
    }

    #[test]
    fn a_failure_resets_the_cycle_for_a_later_retry() {
        let mut coordinator = SnapshotRefreshCoordinator::new();
        coordinator.request();
        coordinator.request();
        assert_eq!(
            coordinator.complete_run(SnapshotRefreshRunResult::Failed),
            SnapshotRefreshAction::Idle { cycle: 0 }
        );
        assert_eq!(
            coordinator.request(),
            SnapshotRefreshAction::Start { cycle: 1 }
        );
    }
}
