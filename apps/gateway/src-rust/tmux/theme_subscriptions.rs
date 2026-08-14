use std::collections::HashSet;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThemeSubscriptionTracker {
    subscribed: Vec<String>,
}

impl ThemeSubscriptionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn note(&mut self, pane_id: impl Into<String>, subscribed: bool) {
        let pane_id = pane_id.into();
        if subscribed {
            if !self.has(&pane_id) {
                self.subscribed.push(pane_id);
            }
        } else {
            self.clear(&pane_id);
        }
    }

    pub fn clear(&mut self, pane_id: &str) {
        self.subscribed.retain(|candidate| candidate != pane_id);
    }

    pub fn prune(&mut self, valid_pane_ids: &HashSet<String>) {
        self.subscribed
            .retain(|pane_id| valid_pane_ids.contains(pane_id));
    }

    pub fn restore<I, S>(&mut self, pane_ids: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for pane_id in pane_ids {
            self.note(pane_id, true);
        }
    }

    pub fn has(&self, pane_id: &str) -> bool {
        self.subscribed.iter().any(|candidate| candidate == pane_id)
    }

    pub fn list(&self) -> &[String] {
        &self.subscribed
    }

    pub fn reset(&mut self) {
        self.subscribed.clear();
    }
}
