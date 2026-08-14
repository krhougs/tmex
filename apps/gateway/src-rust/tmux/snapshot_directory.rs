use std::sync::{Arc, RwLock};

use tmex_protocol::StateSnapshot;

type SnapshotLookup = Arc<dyn Fn(&str) -> Option<StateSnapshot> + Send + Sync + 'static>;

#[derive(Clone, Default)]
pub struct SnapshotDirectory {
    lookup: Arc<RwLock<Option<SnapshotLookup>>>,
}

impl SnapshotDirectory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<Lookup>(&self, lookup: Option<Lookup>)
    where
        Lookup: Fn(&str) -> Option<StateSnapshot> + Send + Sync + 'static,
    {
        *self
            .lookup
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            lookup.map(|lookup| Arc::new(lookup) as SnapshotLookup);
    }

    pub fn clear(&self) {
        *self
            .lookup
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub fn get(&self, device_id: &str) -> Option<StateSnapshot> {
        let lookup = self
            .lookup
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        lookup.and_then(|lookup| lookup(device_id))
    }
}
