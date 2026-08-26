use std::collections::{HashMap, VecDeque};

use tmex_protocol::WireToken;

pub const KITTY_SCREEN_CACHE_BYTES_PER_PANE: usize = 6 * 1024 * 1024;
pub const KITTY_SCREEN_CACHE_BYTES_TOTAL: usize = 32 * 1024 * 1024;

type PaneKey = (String, WireToken);
type AssetKey = (String, WireToken, u32);

struct Asset {
    data: Vec<u8>,
}

pub struct KittyScreenCache {
    assets: HashMap<AssetKey, Asset>,
    order: VecDeque<AssetKey>,
    pane_bytes: HashMap<PaneKey, usize>,
    total_bytes: usize,
    per_pane_limit: usize,
    total_limit: usize,
}

impl Default for KittyScreenCache {
    fn default() -> Self {
        Self::with_limits(
            KITTY_SCREEN_CACHE_BYTES_PER_PANE,
            KITTY_SCREEN_CACHE_BYTES_TOTAL,
        )
    }
}

impl KittyScreenCache {
    fn with_limits(per_pane_limit: usize, total_limit: usize) -> Self {
        Self {
            assets: HashMap::new(),
            order: VecDeque::new(),
            pane_bytes: HashMap::new(),
            total_bytes: 0,
            per_pane_limit,
            total_limit,
        }
    }

    pub fn store(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        image_id: u32,
        data: Vec<u8>,
    ) -> bool {
        let key = (pane_id.to_owned(), pane_epoch, image_id);
        self.remove(&key);
        self.remove_other_epochs(pane_id, pane_epoch);
        if image_id == 0
            || data.is_empty()
            || data.len() > self.per_pane_limit
            || data.len() > self.total_limit
        {
            return false;
        }

        let pane_key = (pane_id.to_owned(), pane_epoch);
        while self
            .pane_bytes
            .get(&pane_key)
            .copied()
            .unwrap_or(0)
            .saturating_add(data.len())
            > self.per_pane_limit
        {
            let Some(oldest) = self
                .order
                .iter()
                .find(|candidate| candidate.0 == pane_id && candidate.1 == pane_epoch)
                .cloned()
            else {
                return false;
            };
            self.remove(&oldest);
        }
        while self.total_bytes.saturating_add(data.len()) > self.total_limit {
            let Some(oldest) = self.order.front().cloned() else {
                return false;
            };
            self.remove(&oldest);
        }

        let bytes = data.len();
        self.assets.insert(key.clone(), Asset { data });
        self.order.push_back(key);
        *self.pane_bytes.entry(pane_key).or_default() += bytes;
        self.total_bytes += bytes;
        true
    }

    pub fn delete(&mut self, pane_id: &str, pane_epoch: WireToken, image_id: Option<u32>) {
        if let Some(image_id) = image_id {
            self.remove(&(pane_id.to_owned(), pane_epoch, image_id));
            return;
        }
        let keys = self
            .order
            .iter()
            .filter(|key| key.0 == pane_id && key.1 == pane_epoch)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove(&key);
        }
    }

    pub fn clear_pane(&mut self, pane_id: &str) {
        let keys = self
            .order
            .iter()
            .filter(|key| key.0 == pane_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove(&key);
        }
    }

    pub fn replay_prefix(
        &self,
        pane_id: &str,
        pane_epoch: WireToken,
        byte_limit: usize,
    ) -> Vec<u8> {
        let mut remaining = byte_limit;
        let mut selected = Vec::new();
        for key in self.order.iter().rev() {
            if key.0 != pane_id || key.1 != pane_epoch {
                continue;
            }
            let Some(asset) = self.assets.get(key) else {
                continue;
            };
            if asset.data.len() > remaining {
                continue;
            }
            remaining -= asset.data.len();
            selected.push(asset.data.as_slice());
        }
        let total = byte_limit - remaining;
        let mut replay = Vec::with_capacity(total);
        for data in selected.into_iter().rev() {
            replay.extend_from_slice(data);
        }
        replay
    }

    fn remove_other_epochs(&mut self, pane_id: &str, pane_epoch: WireToken) {
        let keys = self
            .order
            .iter()
            .filter(|key| key.0 == pane_id && key.1 != pane_epoch)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove(&key);
        }
    }

    fn remove(&mut self, key: &AssetKey) {
        let Some(asset) = self.assets.remove(key) else {
            return;
        };
        self.order.retain(|candidate| candidate != key);
        let pane_key = (key.0.clone(), key.1);
        if let Some(bytes) = self.pane_bytes.get_mut(&pane_key) {
            *bytes = bytes.saturating_sub(asset.data.len());
            if *bytes == 0 {
                self.pane_bytes.remove(&pane_key);
            }
        }
        self.total_bytes = self.total_bytes.saturating_sub(asset.data.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_eviction_epoch_and_complete_asset_budget_are_bounded() {
        let mut cache = KittyScreenCache::with_limits(6, 10);
        assert!(cache.store("%1", [1; 16], 1, b"aaa".to_vec()));
        assert!(cache.store("%1", [1; 16], 2, b"bbb".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 6), b"aaabbb");

        assert!(cache.store("%1", [1; 16], 2, b"BBBB".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 6), b"BBBB");
        assert!(cache.store("%1", [1; 16], 3, b"cc".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 5), b"cc");

        assert!(cache.store("%2", [2; 16], 4, b"dddd".to_vec()));
        assert_eq!(cache.total_bytes, 10);
        assert!(cache.store("%2", [2; 16], 5, b"ee".to_vec()));
        assert!(cache.total_bytes <= 10);

        assert!(cache.store("%1", [3; 16], 6, b"new".to_vec()));
        assert!(cache.replay_prefix("%1", [1; 16], 10).is_empty());
        assert_eq!(cache.replay_prefix("%1", [3; 16], 10), b"new");
        assert!(!cache.store("%1", [3; 16], 7, b"oversized".to_vec()));
    }

    #[test]
    fn delete_and_clear_remove_only_requested_assets() {
        let mut cache = KittyScreenCache::with_limits(16, 32);
        assert!(cache.store("%1", [1; 16], 1, b"one".to_vec()));
        assert!(cache.store("%1", [1; 16], 2, b"two".to_vec()));
        assert!(cache.store("%2", [2; 16], 1, b"other".to_vec()));

        cache.delete("%1", [1; 16], Some(1));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 16), b"two");
        cache.delete("%1", [1; 16], None);
        assert!(cache.replay_prefix("%1", [1; 16], 16).is_empty());
        assert_eq!(cache.replay_prefix("%2", [2; 16], 16), b"other");
        cache.clear_pane("%2");
        assert_eq!(cache.total_bytes, 0);
    }
}
