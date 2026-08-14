use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tmex_protocol::{
    SourceMetadataValue, StateSnapshot, SOURCE_ENTITY_PANE, SOURCE_ENTITY_WINDOW,
    SOURCE_FIELD_CUSTOM_NAME,
};

use crate::tmux::{DeviceSessionRuntime, TmuxRuntimeEvent, TmuxRuntimeRegistry};

use super::PushError;

pub type PushTask = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

pub trait PushRuntimeListener: Send + Sync {
    fn on_event(&self, event: TmuxRuntimeEvent);
}

pub trait PushRuntimeSubscription: Send + Sync {
    fn cancel(&self);
}

#[async_trait]
pub trait PushRuntimeLease: Send + Sync {
    fn subscribe(
        &self,
        listener: Arc<dyn PushRuntimeListener>,
    ) -> Result<Arc<dyn PushRuntimeSubscription>, PushError>;

    fn request_snapshot(&self) -> Result<(), PushError>;

    async fn current_snapshot(&self) -> Result<Option<StateSnapshot>, PushError>;

    async fn custom_name(
        &self,
        entity_kind: u8,
        native_id: &str,
    ) -> Result<Option<String>, PushError>;

    async fn update_default_working_dir(&self, directory: Option<String>) -> Result<(), PushError>;

    async fn release(&self);
}

#[async_trait]
pub trait PushRuntimeHost: Send + Sync {
    async fn acquire(&self, device_id: &str) -> Result<Arc<dyn PushRuntimeLease>, PushError>;
}

pub trait PushScheduledTask: Send + Sync {
    fn cancel(&self);
}

pub trait PushScheduler: Send + Sync {
    fn spawn(&self, task: PushTask);

    fn schedule(&self, delay: Duration, task: PushTask) -> Arc<dyn PushScheduledTask>;
}

#[derive(Clone, Default)]
pub struct SystemPushScheduler;

impl PushScheduler for SystemPushScheduler {
    fn spawn(&self, task: PushTask) {
        drop(tokio::spawn(task));
    }

    fn schedule(&self, delay: Duration, task: PushTask) -> Arc<dyn PushScheduledTask> {
        let task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            task.await;
        });
        Arc::new(TokioScheduledTask {
            abort: task.abort_handle(),
        })
    }
}

struct TokioScheduledTask {
    abort: tokio::task::AbortHandle,
}

impl PushScheduledTask for TokioScheduledTask {
    fn cancel(&self) {
        self.abort.abort();
    }
}

#[derive(Clone)]
pub struct DeviceSessionRuntimeHost {
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
}

impl DeviceSessionRuntimeHost {
    pub fn new(registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl PushRuntimeHost for DeviceSessionRuntimeHost {
    async fn acquire(&self, device_id: &str) -> Result<Arc<dyn PushRuntimeLease>, PushError> {
        let runtime = self
            .registry
            .acquire(device_id)
            .await
            .map_err(|error| PushError::new(error.to_string()))?;
        Ok(Arc::new(DeviceSessionRuntimeLease {
            device_id: device_id.to_owned(),
            registry: self.registry.clone(),
            runtime,
            runtime_handle: tokio::runtime::Handle::current(),
            release: ReleaseCompletion::default(),
        }))
    }
}

struct DeviceSessionRuntimeLease {
    device_id: String,
    registry: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    runtime: Arc<DeviceSessionRuntime>,
    runtime_handle: tokio::runtime::Handle,
    release: ReleaseCompletion,
}

#[derive(Default)]
struct ReleaseCompletion {
    started: AtomicBool,
    complete: Arc<AtomicBool>,
    notified: Arc<tokio::sync::Notify>,
}

impl ReleaseCompletion {
    fn start(&self, runtime_handle: &tokio::runtime::Handle, task: PushTask) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let complete = self.complete.clone();
        let notified = self.notified.clone();
        drop(runtime_handle.spawn(async move {
            task.await;
            complete.store(true, Ordering::Release);
            notified.notify_waiters();
        }));
    }

    async fn wait(&self) {
        loop {
            let notified = self.notified.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.complete.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

impl DeviceSessionRuntimeLease {
    fn start_release(&self) {
        let device_id = self.device_id.clone();
        let registry = self.registry.clone();
        let runtime = self.runtime.clone();
        self.release.start(
            &self.runtime_handle,
            Box::pin(async move {
                registry.release(&device_id, Some(&runtime)).await;
            }),
        );
    }
}

impl Drop for DeviceSessionRuntimeLease {
    fn drop(&mut self) {
        self.start_release();
    }
}

#[async_trait]
impl PushRuntimeLease for DeviceSessionRuntimeLease {
    fn subscribe(
        &self,
        listener: Arc<dyn PushRuntimeListener>,
    ) -> Result<Arc<dyn PushRuntimeSubscription>, PushError> {
        let mut receiver = self.runtime.subscribe();
        let device_id = self.device_id.clone();
        let task = tokio::spawn(async move {
            let mut closed_event_seen = false;
            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        closed_event_seen |= matches!(event, TmuxRuntimeEvent::Closed { .. });
                        listener.on_event(event);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        listener.on_event(TmuxRuntimeEvent::Error {
                            device_id: device_id.clone(),
                            message: format!(
                                "push runtime event stream lagged by {skipped} events"
                            ),
                        });
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        if !closed_event_seen {
                            listener.on_event(TmuxRuntimeEvent::Closed {
                                device_id: device_id.clone(),
                                manual: false,
                            });
                        }
                        break;
                    }
                }
            }
        });
        Ok(Arc::new(DeviceSessionRuntimeSubscription {
            abort: task.abort_handle(),
            cancelled: AtomicBool::new(false),
        }))
    }

    fn request_snapshot(&self) -> Result<(), PushError> {
        self.runtime
            .request_snapshot()
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn current_snapshot(&self) -> Result<Option<StateSnapshot>, PushError> {
        self.runtime
            .current_snapshot()
            .await
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn custom_name(
        &self,
        entity_kind: u8,
        native_id: &str,
    ) -> Result<Option<String>, PushError> {
        if !matches!(entity_kind, SOURCE_ENTITY_WINDOW | SOURCE_ENTITY_PANE) {
            return Ok(None);
        }
        let metadata = self
            .runtime
            .metadata_snapshot()
            .await
            .map_err(|error| PushError::new(error.to_string()))?;
        Ok(metadata
            .records
            .iter()
            .find(|record| {
                record.key.entity_kind == entity_kind && record.key.native_id == native_id
            })
            .and_then(|record| {
                record
                    .fields
                    .iter()
                    .find(|field| field.field == SOURCE_FIELD_CUSTOM_NAME)
            })
            .and_then(|field| match &field.value {
                SourceMetadataValue::String(value) if !value.is_empty() => Some(value.clone()),
                _ => None,
            }))
    }

    async fn update_default_working_dir(&self, directory: Option<String>) -> Result<(), PushError> {
        self.runtime
            .try_update_default_working_dir(directory)
            .map_err(|error| PushError::new(error.to_string()))
    }

    async fn release(&self) {
        self.start_release();
        self.release.wait().await;
    }
}

struct DeviceSessionRuntimeSubscription {
    abort: tokio::task::AbortHandle,
    cancelled: AtomicBool,
}

impl PushRuntimeSubscription for DeviceSessionRuntimeSubscription {
    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.abort.abort();
        }
    }
}

impl Drop for DeviceSessionRuntimeSubscription {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(crate) struct RuntimeConnection {
    pub lease: Arc<dyn PushRuntimeLease>,
    pub subscription: Arc<dyn PushRuntimeSubscription>,
}

impl RuntimeConnection {
    pub fn cancel_subscription(&self) {
        self.subscription.cancel();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn detached_release_finishes_after_waiting_caller_is_cancelled() {
        let release = Arc::new(ReleaseCompletion::default());
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let completed = Arc::new(AtomicUsize::new(0));
        let waiter = tokio::spawn({
            let release = release.clone();
            let gate = gate.clone();
            let started = started.clone();
            let completed = completed.clone();
            async move {
                release.start(
                    &tokio::runtime::Handle::current(),
                    Box::pin(async move {
                        started.notify_one();
                        let _permit = gate.acquire().await.expect("release gate open");
                        completed.fetch_add(1, Ordering::AcqRel);
                    }),
                );
                release.wait().await;
            }
        });

        started.notified().await;
        waiter.abort();
        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), release.wait())
            .await
            .expect("detached release should finish");
        assert_eq!(completed.load(Ordering::Acquire), 1);
    }
}
