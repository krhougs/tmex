use std::sync::{Arc, RwLock};

use super::ThemeMode;

type ThemeCallback = Arc<dyn Fn(ThemeMode) + Send + Sync + 'static>;

#[derive(Clone, Default)]
pub struct ThemeBroadcaster {
    callbacks: Arc<RwLock<ThemeCallbacks>>,
}

#[derive(Clone, Default)]
struct ThemeCallbacks {
    tmux: Option<ThemeCallback>,
    s2c: Option<ThemeCallback>,
}

impl ThemeBroadcaster {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<Tmux, S2c>(&self, tmux: Option<Tmux>, s2c: Option<S2c>)
    where
        Tmux: Fn(ThemeMode) + Send + Sync + 'static,
        S2c: Fn(ThemeMode) + Send + Sync + 'static,
    {
        *self
            .callbacks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ThemeCallbacks {
            tmux: tmux.map(|callback| Arc::new(callback) as ThemeCallback),
            s2c: s2c.map(|callback| Arc::new(callback) as ThemeCallback),
        };
    }

    pub fn clear(&self) {
        *self
            .callbacks
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = ThemeCallbacks::default();
    }

    pub fn broadcast_tmux(&self, theme: ThemeMode) {
        let callback = self
            .callbacks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tmux
            .clone();
        if let Some(callback) = callback {
            callback(theme);
        }
    }

    pub fn broadcast_s2c(&self, theme: ThemeMode) {
        let callback = self
            .callbacks
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .s2c
            .clone();
        if let Some(callback) = callback {
            callback(theme);
        }
    }
}
