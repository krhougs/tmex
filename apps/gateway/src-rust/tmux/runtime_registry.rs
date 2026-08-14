use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, TryLockError};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use tokio::runtime::Handle;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeRegistryError {
    pub message: String,
}

impl RuntimeRegistryError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for RuntimeRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RuntimeRegistryError {}

#[async_trait]
pub trait ManagedTmuxRuntime: Send + Sync + 'static {
    fn is_terminated(&self) -> bool;
    async fn shutdown(&self);
}

type FactoryFuture<R> = BoxFuture<'static, Result<Arc<R>, RuntimeRegistryError>>;
type SharedFactoryFuture<R> = Shared<FactoryFuture<R>>;

pub trait TmuxRuntimeFactory<R>: Send + Sync + 'static {
    fn create(&self, device_id: String) -> FactoryFuture<R>;
}

impl<R, Factory, Fut> TmuxRuntimeFactory<R> for Factory
where
    R: ManagedTmuxRuntime,
    Factory: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Arc<R>, RuntimeRegistryError>> + Send + 'static,
{
    fn create(&self, device_id: String) -> FactoryFuture<R> {
        Box::pin((self)(device_id))
    }
}

struct RegistryEntry<R> {
    id: u64,
    refs: usize,
    waiters: usize,
    runtime: SharedFactoryFuture<R>,
}

impl<R> RegistryEntry<R> {
    fn new(id: u64, runtime: SharedFactoryFuture<R>) -> Self {
        Self {
            id,
            refs: 0,
            waiters: 0,
            runtime,
        }
    }
}

struct RegistryState<R> {
    next_id: u64,
    entries: HashMap<String, RegistryEntry<R>>,
    orphans: HashMap<String, Vec<RegistryEntry<R>>>,
}

impl<R> Default for RegistryState<R> {
    fn default() -> Self {
        Self {
            next_id: 0,
            entries: HashMap::new(),
            orphans: HashMap::new(),
        }
    }
}

impl<R> RegistryState<R> {
    fn entry_mut_by_id(&mut self, device_id: &str, entry_id: u64) -> Option<&mut RegistryEntry<R>> {
        if self
            .entries
            .get(device_id)
            .is_some_and(|entry| entry.id == entry_id)
        {
            return self.entries.get_mut(device_id);
        }
        self.orphans
            .get_mut(device_id)?
            .iter_mut()
            .find(|entry| entry.id == entry_id)
    }

    fn cancel_waiter(&mut self, device_id: &str, entry_id: u64) -> Option<RegistryEntry<R>> {
        if self
            .entries
            .get(device_id)
            .is_some_and(|entry| entry.id == entry_id)
        {
            let remove = {
                let entry = self.entries.get_mut(device_id)?;
                entry.waiters = entry.waiters.saturating_sub(1);
                entry.refs == 0 && entry.waiters == 0
            };
            return remove.then(|| self.entries.remove(device_id)).flatten();
        }
        let orphans = self.orphans.get_mut(device_id)?;
        let index = orphans.iter().position(|entry| entry.id == entry_id)?;
        let entry = &mut orphans[index];
        entry.waiters = entry.waiters.saturating_sub(1);
        if entry.refs != 0 || entry.waiters != 0 {
            return None;
        }
        let entry = orphans.remove(index);
        if orphans.is_empty() {
            self.orphans.remove(device_id);
        }
        Some(entry)
    }
}

pub struct TmuxRuntimeRegistry<R> {
    factory: Arc<dyn TmuxRuntimeFactory<R>>,
    state: Mutex<RegistryState<R>>,
    #[cfg(test)]
    commit_contentions: AtomicUsize,
}

struct AcquireReservation<'a, R>
where
    R: ManagedTmuxRuntime,
{
    registry: &'a TmuxRuntimeRegistry<R>,
    device_id: String,
    entry_id: u64,
    runtime_handle: Handle,
    active: bool,
}

enum CommitAttempt {
    Complete(Result<(), RuntimeRegistryError>),
    Contended,
}

impl<R> AcquireReservation<'_, R>
where
    R: ManagedTmuxRuntime,
{
    async fn commit(mut self, runtime: &Arc<R>) -> Result<(), RuntimeRegistryError> {
        loop {
            match self.try_commit(runtime) {
                CommitAttempt::Contended => {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                CommitAttempt::Complete(result) => {
                    if result.is_ok() {
                        self.active = false;
                    }
                    return result;
                }
            }
        }
    }

    fn try_commit(&self, runtime: &Arc<R>) -> CommitAttempt {
        match self.registry.state.try_lock() {
            Ok(mut state) => CommitAttempt::Complete(commit_reservation(
                &mut state,
                &self.device_id,
                self.entry_id,
                runtime,
            )),
            Err(TryLockError::Poisoned(error)) => CommitAttempt::Complete(commit_reservation(
                &mut error.into_inner(),
                &self.device_id,
                self.entry_id,
                runtime,
            )),
            Err(TryLockError::WouldBlock) => {
                #[cfg(test)]
                self.registry
                    .commit_contentions
                    .fetch_add(1, Ordering::Release);
                CommitAttempt::Contended
            }
        }
    }
}

impl<R> Drop for AcquireReservation<'_, R>
where
    R: ManagedTmuxRuntime,
{
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let removed = self
            .registry
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancel_waiter(&self.device_id, self.entry_id);
        if let Some(runtime) = removed.as_ref().and_then(resolved_runtime) {
            drop(self.runtime_handle.spawn(async move {
                runtime.shutdown().await;
            }));
        }
    }
}

impl<R> TmuxRuntimeRegistry<R>
where
    R: ManagedTmuxRuntime,
{
    pub fn new(factory: Arc<dyn TmuxRuntimeFactory<R>>) -> Self {
        Self {
            factory,
            state: Mutex::new(RegistryState::default()),
            #[cfg(test)]
            commit_contentions: AtomicUsize::new(0),
        }
    }

    pub async fn peek(&self, device_id: &str) -> Option<Arc<R>> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let runtime = state
            .entries
            .get(device_id)?
            .runtime
            .peek()?
            .as_ref()
            .ok()?;
        (!runtime.is_terminated()).then(|| runtime.clone())
    }

    pub async fn acquire(&self, device_id: &str) -> Result<Arc<R>, RuntimeRegistryError> {
        let runtime_handle = Handle::try_current().map_err(|_| {
            RuntimeRegistryError::new("tmux runtime registry requires a Tokio runtime")
        })?;
        let (entry_id, runtime) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let replace = state
                .entries
                .get(device_id)
                .and_then(|entry| entry.runtime.peek().map(|runtime| (entry.id, runtime)))
                .is_some_and(|(_, runtime)| {
                    runtime
                        .as_ref()
                        .is_ok_and(|runtime| runtime.is_terminated())
                });
            if replace {
                if let Some(old) = state.entries.remove(device_id) {
                    if old.refs > 0 || old.waiters > 0 {
                        state
                            .orphans
                            .entry(device_id.to_owned())
                            .or_default()
                            .push(old);
                    }
                }
            }
            let (entry_id, runtime) = if let Some(entry) = state.entries.get_mut(device_id) {
                entry.waiters = entry.waiters.saturating_add(1);
                (entry.id, entry.runtime.clone())
            } else {
                let id = state.next_id;
                state.next_id = state.next_id.wrapping_add(1);
                let runtime = self.factory.create(device_id.to_owned()).shared();
                let mut entry = RegistryEntry::new(id, runtime.clone());
                entry.waiters = 1;
                state.entries.insert(device_id.to_owned(), entry);
                (id, runtime)
            };
            (entry_id, runtime)
        };
        let reservation = AcquireReservation {
            registry: self,
            device_id: device_id.to_owned(),
            entry_id,
            runtime_handle,
            active: true,
        };
        let runtime = runtime.await?;
        reservation.commit(&runtime).await?;
        Ok(runtime)
    }

    pub async fn release(&self, device_id: &str, runtime: Option<&Arc<R>>) {
        let mut shutdown = None;
        let mut handled_orphan = false;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(runtime) = runtime {
                if let Some(orphaned) = state.orphans.get_mut(device_id) {
                    if let Some(index) = orphaned.iter().position(|entry| {
                        entry
                            .runtime
                            .peek()
                            .and_then(|result| result.as_ref().ok())
                            .is_some_and(|candidate| Arc::ptr_eq(candidate, runtime))
                    }) {
                        handled_orphan = true;
                        let entry = &mut orphaned[index];
                        entry.refs = entry.refs.saturating_sub(1);
                        if entry.refs == 0 && entry.waiters == 0 {
                            let entry = orphaned.remove(index);
                            shutdown = resolved_runtime(&entry);
                        }
                        if orphaned.is_empty() {
                            state.orphans.remove(device_id);
                        }
                    } else if state.entries.get(device_id).is_some_and(|entry| {
                        entry
                            .runtime
                            .peek()
                            .and_then(|result| result.as_ref().ok())
                            .is_some_and(|candidate| !Arc::ptr_eq(candidate, runtime))
                    }) {
                        return;
                    }
                } else if state.entries.get(device_id).is_some_and(|entry| {
                    entry
                        .runtime
                        .peek()
                        .and_then(|result| result.as_ref().ok())
                        .is_some_and(|candidate| !Arc::ptr_eq(candidate, runtime))
                }) {
                    return;
                }
            }
            if !handled_orphan && shutdown.is_none() {
                let remove = if let Some(entry) = state.entries.get_mut(device_id) {
                    if entry.refs == 0 {
                        false
                    } else {
                        entry.refs -= 1;
                        entry.refs == 0 && entry.waiters == 0
                    }
                } else {
                    false
                };
                if remove {
                    if let Some(entry) = state.entries.remove(device_id) {
                        shutdown = resolved_runtime(&entry);
                    }
                }
            }
        }
        if let Some(runtime) = shutdown {
            runtime.shutdown().await;
        }
    }

    pub async fn shutdown_all(&self) {
        let entries = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut entries = state
                .entries
                .drain()
                .map(|(_, entry)| entry.runtime)
                .collect::<Vec<_>>();
            entries.extend(
                state
                    .orphans
                    .drain()
                    .flat_map(|(_, entries)| entries.into_iter().map(|entry| entry.runtime)),
            );
            entries
        };
        for runtime in entries {
            if let Ok(runtime) = runtime.await {
                runtime.shutdown().await;
            }
        }
    }
}

fn invalidated_acquire(device_id: &str) -> RuntimeRegistryError {
    RuntimeRegistryError::new(format!(
        "tmux runtime acquisition for {device_id} was invalidated"
    ))
}

fn commit_reservation<R>(
    state: &mut RegistryState<R>,
    device_id: &str,
    entry_id: u64,
    runtime: &Arc<R>,
) -> Result<(), RuntimeRegistryError>
where
    R: ManagedTmuxRuntime,
{
    let Some(entry) = state.entry_mut_by_id(device_id, entry_id) else {
        return Err(invalidated_acquire(device_id));
    };
    if runtime.is_terminated() {
        return Err(invalidated_acquire(device_id));
    }
    let same_runtime = entry
        .runtime
        .peek()
        .and_then(|result| result.as_ref().ok())
        .is_some_and(|candidate| Arc::ptr_eq(candidate, runtime));
    if !same_runtime || entry.waiters == 0 {
        return Err(invalidated_acquire(device_id));
    }
    entry.waiters -= 1;
    entry.refs = entry.refs.saturating_add(1);
    Ok(())
}

fn resolved_runtime<R>(entry: &RegistryEntry<R>) -> Option<Arc<R>> {
    entry.runtime.peek()?.as_ref().ok().cloned()
}

#[cfg(test)]
mod tests {
    use std::future::pending;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use tokio::sync::Notify;
    use tokio::time::{timeout, Duration};

    struct FakeRuntime {
        terminated: AtomicBool,
        shutdowns: AtomicUsize,
    }

    #[async_trait]
    impl ManagedTmuxRuntime for FakeRuntime {
        fn is_terminated(&self) -> bool {
            self.terminated.load(Ordering::Acquire)
        }

        async fn shutdown(&self) {
            self.shutdowns.fetch_add(1, Ordering::AcqRel);
            self.terminated.store(true, Ordering::Release);
        }
    }

    fn fake() -> Arc<FakeRuntime> {
        Arc::new(FakeRuntime {
            terminated: AtomicBool::new(false),
            shutdowns: AtomicUsize::new(0),
        })
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    async fn wait_until(predicate: impl Fn() -> bool) {
        timeout(Duration::from_secs(1), async {
            while !predicate() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn concurrent_acquire_is_deduplicated_until_last_release() {
        let creates = Arc::new(AtomicUsize::new(0));
        let creates_for_factory = creates.clone();
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new(move |_| {
            let creates = creates_for_factory.clone();
            async move {
                creates.fetch_add(1, Ordering::AcqRel);
                tokio::task::yield_now().await;
                Ok(fake())
            }
        })));
        let (left, right) = tokio::join!(registry.acquire("device"), registry.acquire("device"));
        let left = left.unwrap();
        let right = right.unwrap();
        assert!(Arc::ptr_eq(&left, &right));
        assert_eq!(creates.load(Ordering::Acquire), 1);
        registry.release("device", Some(&left)).await;
        assert_eq!(left.shutdowns.load(Ordering::Acquire), 0);
        registry.release("device", Some(&right)).await;
        assert_eq!(left.shutdowns.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn terminated_runtime_becomes_an_orphan_without_stealing_new_refs() {
        let registry = TmuxRuntimeRegistry::new(Arc::new(|_| async { Ok(fake()) }));
        let first = registry.acquire("device").await.unwrap();
        first.terminated.store(true, Ordering::Release);
        let second = registry.acquire("device").await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        registry.release("device", Some(&first)).await;
        registry.release("device", Some(&first)).await;
        assert_eq!(first.shutdowns.load(Ordering::Acquire), 1);
        registry.release("device", Some(&second)).await;
        assert_eq!(second.shutdowns.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn cancelled_first_acquire_does_not_leak_a_committed_reference() {
        let creates = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let runtime = fake();
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new({
            let creates = creates.clone();
            let gate = gate.clone();
            let runtime = runtime.clone();
            move |_| {
                let creates = creates.clone();
                let gate = gate.clone();
                let runtime = runtime.clone();
                async move {
                    creates.fetch_add(1, Ordering::AcqRel);
                    gate.notified().await;
                    Ok(runtime)
                }
            }
        })));

        let acquire = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        timeout(Duration::from_secs(1), async {
            while creates.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let second = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        wait_until(|| {
            registry
                .state
                .lock()
                .unwrap()
                .entries
                .get("device")
                .is_some_and(|entry| entry.waiters == 2)
        })
        .await;
        acquire.abort();
        let _ = acquire.await;

        assert_eq!(creates.load(Ordering::Acquire), 1);
        gate.notify_waiters();
        let acquired = timeout(Duration::from_secs(1), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&acquired, &runtime));
        assert_eq!(creates.load(Ordering::Acquire), 1);
        registry.release("device", Some(&acquired)).await;
        assert_eq!(runtime.shutdowns.load(Ordering::Acquire), 1);
        assert!(registry.peek("device").await.is_none());
        let state = registry.state.lock().unwrap();
        assert!(state.entries.is_empty());
        assert!(state.orphans.is_empty());
    }

    #[tokio::test]
    async fn pending_acquire_cannot_escape_concurrent_shutdown_all() {
        let creates = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let runtime = fake();
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new({
            let creates = creates.clone();
            let gate = gate.clone();
            let runtime = runtime.clone();
            move |_| {
                let creates = creates.clone();
                let gate = gate.clone();
                let runtime = runtime.clone();
                async move {
                    creates.fetch_add(1, Ordering::AcqRel);
                    gate.notified().await;
                    Ok(runtime)
                }
            }
        })));

        let acquire = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        timeout(Duration::from_secs(1), async {
            while creates.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let shutdown = tokio::spawn({
            let registry = registry.clone();
            async move { registry.shutdown_all().await }
        });
        timeout(Duration::from_secs(1), async {
            loop {
                if registry.state.lock().unwrap().entries.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        gate.notify_waiters();
        assert!(timeout(Duration::from_secs(1), acquire)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        timeout(Duration::from_secs(1), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(creates.load(Ordering::Acquire), 1);
        assert_eq!(runtime.shutdowns.load(Ordering::Acquire), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_after_factory_resolution_rolls_back_and_shuts_down() {
        let creates = Arc::new(AtomicUsize::new(0));
        let resolved = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(Notify::new());
        let runtime = fake();
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new({
            let creates = creates.clone();
            let resolved = resolved.clone();
            let gate = gate.clone();
            let runtime = runtime.clone();
            move |_| {
                let creates = creates.clone();
                let resolved = resolved.clone();
                let gate = gate.clone();
                let runtime = runtime.clone();
                async move {
                    creates.fetch_add(1, Ordering::AcqRel);
                    gate.notified().await;
                    resolved.store(true, Ordering::Release);
                    Ok(runtime)
                }
            }
        })));
        let acquire = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        wait_until(|| creates.load(Ordering::Acquire) == 1).await;
        let (locked, locked_receiver) = tokio::sync::oneshot::channel();
        let (release, release_receiver) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn({
            let registry = registry.clone();
            move || {
                let _state = registry.state.lock().unwrap();
                let _ = locked.send(());
                let _ = release_receiver.recv();
            }
        });
        locked_receiver.await.unwrap();
        gate.notify_waiters();
        wait_until(|| resolved.load(Ordering::Acquire)).await;
        wait_until(|| registry.commit_contentions.load(Ordering::Acquire) > 0).await;
        acquire.abort();
        release.send(()).unwrap();
        blocker.join().unwrap();
        match acquire.await {
            Err(error) => assert!(error.is_cancelled()),
            Ok(Err(_)) => {}
            Ok(Ok(_)) => panic!("acquire returned a usable runtime after cancellation"),
        }

        wait_until(|| runtime.shutdowns.load(Ordering::Acquire) == 1).await;
        assert_eq!(runtime.shutdowns.load(Ordering::Acquire), 1);
        assert!(registry.state.lock().unwrap().entries.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runtime_terminated_before_commit_is_not_returned() {
        let gate = Arc::new(Notify::new());
        let runtime = fake();
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new({
            let gate = gate.clone();
            let runtime = runtime.clone();
            move |_| {
                let gate = gate.clone();
                let runtime = runtime.clone();
                async move {
                    gate.notified().await;
                    Ok(runtime)
                }
            }
        })));
        let acquire = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        let (locked, locked_receiver) = tokio::sync::oneshot::channel();
        let (release, release_receiver) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn({
            let registry = registry.clone();
            move || {
                let _state = registry.state.lock().unwrap();
                let _ = locked.send(());
                let _ = release_receiver.recv();
            }
        });
        locked_receiver.await.unwrap();
        gate.notify_one();
        runtime.terminated.store(true, Ordering::Release);
        release.send(()).unwrap();
        blocker.join().unwrap();

        assert!(acquire.await.unwrap().is_err());
        wait_until(|| runtime.shutdowns.load(Ordering::Acquire) == 1).await;
        assert!(registry.state.lock().unwrap().entries.is_empty());
    }

    #[tokio::test]
    async fn cancelling_the_only_pending_acquire_drops_the_factory_and_entry() {
        let started = Arc::new(AtomicBool::new(false));
        let factory_dropped = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(TmuxRuntimeRegistry::new(Arc::new({
            let started = started.clone();
            let factory_dropped = factory_dropped.clone();
            move |_| {
                let started = started.clone();
                let drop_flag = DropFlag(factory_dropped.clone());
                async move {
                    let _drop_flag = drop_flag;
                    started.store(true, Ordering::Release);
                    pending::<()>().await;
                    Ok::<Arc<FakeRuntime>, RuntimeRegistryError>(fake())
                }
            }
        })));
        let acquire = tokio::spawn({
            let registry = registry.clone();
            async move { registry.acquire("device").await }
        });
        wait_until(|| started.load(Ordering::Acquire)).await;
        acquire.abort();
        match acquire.await {
            Err(error) => assert!(error.is_cancelled()),
            Ok(_) => panic!("acquire completed after cancellation"),
        }

        wait_until(|| factory_dropped.load(Ordering::Acquire)).await;
        assert!(registry.state.lock().unwrap().entries.is_empty());
    }

    #[tokio::test]
    async fn shutdown_all_drains_current_and_orphaned_runtimes() {
        let registry = TmuxRuntimeRegistry::new(Arc::new(|_| async { Ok(fake()) }));
        let first = registry.acquire("device").await.unwrap();
        first.terminated.store(true, Ordering::Release);
        let second = registry.acquire("device").await.unwrap();

        registry.shutdown_all().await;

        assert_eq!(first.shutdowns.load(Ordering::Acquire), 1);
        assert_eq!(second.shutdowns.load(Ordering::Acquire), 1);
        registry.release("device", Some(&first)).await;
        registry.release("device", Some(&second)).await;
        assert_eq!(first.shutdowns.load(Ordering::Acquire), 1);
        assert_eq!(second.shutdowns.load(Ordering::Acquire), 1);
    }
}
