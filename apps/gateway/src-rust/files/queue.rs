use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::{Mutex as AsyncMutex, Semaphore};

#[derive(Clone)]
pub struct DeviceQueue {
    inner: Arc<QueueInner>,
}

struct QueueInner {
    global: Semaphore,
    devices: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl DeviceQueue {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                global: Semaphore::new(max_concurrent),
                devices: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn run<T, F>(&self, device_id: &str, operation: F) -> T
    where
        F: Future<Output = T>,
    {
        let device = {
            let mut devices = lock_recover(&self.inner.devices);
            devices.retain(|_, mutex| mutex.strong_count() > 0);
            devices
                .entry(device_id.to_owned())
                .or_default()
                .upgrade()
                .unwrap_or_else(|| {
                    let mutex = Arc::new(AsyncMutex::new(()));
                    devices.insert(device_id.to_owned(), Arc::downgrade(&mutex));
                    mutex
                })
        };
        let _device_guard = device.lock().await;
        let Ok(_global_guard) = self.inner.global.acquire().await else {
            return operation.await;
        };
        operation.await
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
