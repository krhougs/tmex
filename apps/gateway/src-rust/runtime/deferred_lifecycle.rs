use std::sync::{Arc, OnceLock};

use crate::tmux::{LifecycleEvent, TmuxLifecycleSink};

#[derive(Default)]
pub(crate) struct DeferredTmuxLifecycleSink {
    sink: OnceLock<Arc<dyn TmuxLifecycleSink>>,
}

impl DeferredTmuxLifecycleSink {
    pub(crate) fn bind(
        &self,
        sink: Arc<dyn TmuxLifecycleSink>,
    ) -> Result<(), DeferredLifecycleBindError> {
        self.sink.set(sink).map_err(|_| DeferredLifecycleBindError)
    }

    #[cfg(test)]
    pub(crate) fn is_bound(&self) -> bool {
        self.sink.get().is_some()
    }
}

impl TmuxLifecycleSink for DeferredTmuxLifecycleSink {
    fn publish(&self, device_id: String, event: LifecycleEvent) {
        if let Some(sink) = self.sink.get() {
            sink.publish(device_id, event);
        } else {
            tracing::error!(
                device_id,
                "tmux lifecycle event arrived before runtime composition completed"
            );
        }
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
#[error("tmux lifecycle sink is already bound")]
pub(crate) struct DeferredLifecycleBindError;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tmux::{LifecycleEventKind, LifecycleTmuxContext};

    use super::*;

    #[derive(Default)]
    struct RecordingSink(AtomicUsize);

    impl TmuxLifecycleSink for RecordingSink {
        fn publish(&self, _device_id: String, _event: LifecycleEvent) {
            self.0.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[test]
    fn lifecycle_sink_is_bound_once_before_forwarding() {
        let deferred = DeferredTmuxLifecycleSink::default();
        let first = Arc::new(RecordingSink::default());
        deferred.publish(
            "before".to_owned(),
            LifecycleEvent {
                kind: LifecycleEventKind::SessionCreated,
                tmux: LifecycleTmuxContext::default(),
                payload: Default::default(),
            },
        );
        assert_eq!(first.0.load(Ordering::Acquire), 0);
        deferred.bind(first.clone()).expect("bind lifecycle sink");
        assert!(deferred.is_bound());
        assert!(deferred.bind(Arc::new(RecordingSink::default())).is_err());
        deferred.publish(
            "after".to_owned(),
            LifecycleEvent {
                kind: LifecycleEventKind::SessionCreated,
                tmux: LifecycleTmuxContext::default(),
                payload: Default::default(),
            },
        );
        assert_eq!(first.0.load(Ordering::Acquire), 1);
    }
}
