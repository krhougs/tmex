use std::collections::{BTreeMap, HashMap, VecDeque};

use tmex_protocol::WireToken;

pub const KITTY_SCREEN_CACHE_BYTES_PER_PANE: usize = 6 * 1024 * 1024;
pub const KITTY_SCREEN_CACHE_BYTES_TOTAL: usize = 32 * 1024 * 1024;
pub const KITTY_SCREEN_CACHE_IMAGES_PER_PANE: usize = 5;

type PaneKey = (String, WireToken);
type AssetKey = (String, WireToken, u32);

struct Asset {
    image: Vec<u8>,
    width: u32,
    height: u32,
    format: u8,
    combined_virtual: bool,
    placements: BTreeMap<u32, Vec<u8>>,
}

impl Asset {
    fn bytes(&self) -> usize {
        self.placements
            .values()
            .fold(self.image.len(), |total, placement| {
                total.saturating_add(placement.len())
            })
    }

    #[allow(dead_code)]
    fn replayable(&self) -> bool {
        self.combined_virtual || !self.placements.is_empty()
    }

    #[allow(dead_code)]
    fn append_to(&self, target: &mut Vec<u8>) {
        target.extend_from_slice(&self.image);
        for placement in self.placements.values() {
            target.extend_from_slice(placement);
        }
    }
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

    pub fn store_image(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        image_id: u32,
        virtual_placement: bool,
        data: Vec<u8>,
    ) -> bool {
        self.store_image_with_meta(
            pane_id,
            pane_epoch,
            image_id,
            0,
            0,
            0,
            virtual_placement,
            data,
        )
    }

    pub fn store_image_with_meta(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        image_id: u32,
        width: u32,
        height: u32,
        format: u8,
        virtual_placement: bool,
        data: Vec<u8>,
    ) -> bool {
        let key = (pane_id.to_owned(), pane_epoch, image_id);
        let previous = self.take(&key);
        self.remove_other_epochs(pane_id, pane_epoch);
        if image_id == 0 || data.is_empty() {
            return false;
        }
        self.insert(
            key,
            Asset {
                image: data,
                width,
                height,
                format,
                combined_virtual: virtual_placement
                    || previous
                        .as_ref()
                        .is_some_and(|asset| asset.combined_virtual),
                placements: previous.map_or_else(BTreeMap::new, |asset| asset.placements),
            },
        )
    }

    pub fn images_for_pane(
        &self,
        pane_id: &str,
        pane_epoch: WireToken,
    ) -> Vec<(u32, u32, u32, u8, Vec<u8>)> {
        self.order
            .iter()
            .filter(|key| key.0 == pane_id && key.1 == pane_epoch)
            .filter_map(|key| {
                let asset = self.assets.get(key)?;
                Some((
                    key.2,
                    asset.width,
                    asset.height,
                    asset.format,
                    asset.image.clone(),
                ))
            })
            .collect()
    }

    pub fn store_placement(
        &mut self,
        pane_id: &str,
        pane_epoch: WireToken,
        image_id: u32,
        placement_id: u32,
        data: Vec<u8>,
    ) -> bool {
        let key = (pane_id.to_owned(), pane_epoch, image_id);
        let Some(mut asset) = self.take(&key) else {
            return false;
        };
        if data.is_empty() {
            return self.insert(key, asset);
        }
        asset.placements.insert(placement_id, data);
        self.insert(key, asset)
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

    #[allow(dead_code)]
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
            let Some(asset) = self.assets.get(key).filter(|asset| asset.replayable()) else {
                continue;
            };
            let bytes = asset.bytes();
            if bytes > remaining {
                continue;
            }
            remaining -= bytes;
            selected.push(asset);
        }
        let mut replay = Vec::with_capacity(byte_limit - remaining);
        for asset in selected.into_iter().rev() {
            asset.append_to(&mut replay);
        }
        replay
    }

    fn insert(&mut self, key: AssetKey, asset: Asset) -> bool {
        let bytes = asset.bytes();
        if bytes == 0 || bytes > self.per_pane_limit || bytes > self.total_limit {
            return false;
        }
        let pane_key = (key.0.clone(), key.1);
        while self
            .order
            .iter()
            .filter(|candidate| candidate.0 == key.0 && candidate.1 == key.1)
            .count()
            >= KITTY_SCREEN_CACHE_IMAGES_PER_PANE
        {
            let Some(oldest) = self
                .order
                .iter()
                .find(|candidate| candidate.0 == key.0 && candidate.1 == key.1)
                .cloned()
            else {
                return false;
            };
            self.remove(&oldest);
        }
        while self
            .pane_bytes
            .get(&pane_key)
            .copied()
            .unwrap_or(0)
            .saturating_add(bytes)
            > self.per_pane_limit
        {
            let Some(oldest) = self
                .order
                .iter()
                .find(|candidate| candidate.0 == key.0 && candidate.1 == key.1)
                .cloned()
            else {
                return false;
            };
            self.remove(&oldest);
        }
        while self.total_bytes.saturating_add(bytes) > self.total_limit {
            let Some(oldest) = self.order.front().cloned() else {
                return false;
            };
            self.remove(&oldest);
        }

        self.assets.insert(key.clone(), asset);
        self.order.push_back(key);
        *self.pane_bytes.entry(pane_key).or_default() += bytes;
        self.total_bytes += bytes;
        true
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

    fn take(&mut self, key: &AssetKey) -> Option<Asset> {
        let asset = self.assets.remove(key)?;
        self.order.retain(|candidate| candidate != key);
        let bytes = asset.bytes();
        let pane_key = (key.0.clone(), key.1);
        if let Some(retained) = self.pane_bytes.get_mut(&pane_key) {
            *retained = retained.saturating_sub(bytes);
            if *retained == 0 {
                self.pane_bytes.remove(&pane_key);
            }
        }
        self.total_bytes = self.total_bytes.saturating_sub(bytes);
        Some(asset)
    }

    fn remove(&mut self, key: &AssetKey) {
        let _ = self.take(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_and_separate_virtual_images_produce_complete_replay() {
        let mut cache = KittyScreenCache::with_limits(32, 64);
        assert!(cache.store_image("%1", [1; 16], 1, true, b"combined".to_vec()));
        assert!(cache.store_image("%1", [1; 16], 2, false, b"image".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 64), b"combined");
        assert!(cache.store_placement("%1", [1; 16], 2, 7, b"placement".to_vec()));
        assert_eq!(
            cache.replay_prefix("%1", [1; 16], 64),
            b"combinedimageplacement"
        );
    }

    #[test]
    fn replacement_eviction_epoch_and_complete_asset_budget_are_bounded() {
        let mut cache = KittyScreenCache::with_limits(6, 10);
        assert!(cache.store_image("%1", [1; 16], 1, true, b"aaa".to_vec()));
        assert!(cache.store_image("%1", [1; 16], 2, true, b"bbb".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 6), b"aaabbb");

        assert!(cache.store_image("%1", [1; 16], 2, true, b"BBBB".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 6), b"BBBB");
        assert!(cache.store_image("%1", [1; 16], 3, true, b"cc".to_vec()));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 5), b"cc");

        assert!(cache.store_image("%2", [2; 16], 4, true, b"dddd".to_vec()));
        assert_eq!(cache.total_bytes, 10);
        assert!(cache.store_image("%2", [2; 16], 5, true, b"ee".to_vec()));
        assert!(cache.total_bytes <= 10);

        assert!(cache.store_image("%1", [3; 16], 6, true, b"new".to_vec()));
        assert!(cache.replay_prefix("%1", [1; 16], 10).is_empty());
        assert_eq!(cache.replay_prefix("%1", [3; 16], 10), b"new");
        assert!(!cache.store_image("%1", [3; 16], 7, true, b"oversized".to_vec()));
    }

    #[test]
    fn delete_and_clear_remove_only_requested_assets() {
        let mut cache = KittyScreenCache::with_limits(16, 32);
        assert!(cache.store_image("%1", [1; 16], 1, true, b"one".to_vec()));
        assert!(cache.store_image("%1", [1; 16], 2, true, b"two".to_vec()));
        assert!(cache.store_image("%2", [2; 16], 1, true, b"other".to_vec()));

        cache.delete("%1", [1; 16], Some(1));
        assert_eq!(cache.replay_prefix("%1", [1; 16], 16), b"two");
        cache.delete("%1", [1; 16], None);
        assert!(cache.replay_prefix("%1", [1; 16], 16).is_empty());
        assert_eq!(cache.replay_prefix("%2", [2; 16], 16), b"other");
        cache.clear_pane("%2");
        assert_eq!(cache.total_bytes, 0);
    }

    #[test]
    fn pane_keeps_at_most_five_images() {
        let mut cache = KittyScreenCache::with_limits(1024, 4096);
        for image_id in 1..=6 {
            assert!(cache.store_image(
                "%1",
                [1; 16],
                image_id,
                true,
                format!("img{image_id}").into_bytes(),
            ));
        }
        let replay = cache.replay_prefix("%1", [1; 16], 4096);
        assert!(!replay.windows(4).any(|window| window == b"img1"));
        for image_id in 2..=6u32 {
            let needle = format!("img{image_id}").into_bytes();
            assert!(
                replay.windows(needle.len()).any(|window| window == needle),
                "expected img{image_id}"
            );
        }
    }

    #[test]
    fn images_for_pane_keeps_format_metadata() {
        let mut cache = KittyScreenCache::with_limits(1024, 4096);
        assert!(cache.store_image_with_meta("%1", [1; 16], 7, 2, 3, 100, true, b"png".to_vec(),));
        assert_eq!(
            cache.images_for_pane("%1", [1; 16]),
            vec![(7, 2, 3, 100, b"png".to_vec())]
        );
    }
}
