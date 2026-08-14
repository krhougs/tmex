use std::any::Any;
use std::future::pending;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::FutureExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Sleep;

use crate::ipc::{GatewayClient, GatewayCommand, GatewayIngress, IpcError};
use crate::lifecycle::{GatewayState, LifecycleController};

use super::composition::{site_defaults, RuntimeServices};
use super::control::RuntimeControl;
use super::ports::{
    GatewayRuntimeDependencies, GatewayRuntimeError, GatewayRuntimeExit, GatewayRuntimeOptions,
};

pub struct GatewayRuntime {
    client: GatewayClient,
    task: Option<JoinHandle<Result<GatewayRuntimeExit, GatewayRuntimeError>>>,
}

impl GatewayRuntime {
    pub async fn start(
        dependencies: GatewayRuntimeDependencies,
    ) -> Result<Self, GatewayRuntimeError> {
        Self::start_with_options(dependencies, GatewayRuntimeOptions::default()).await
    }

    pub async fn start_with_options(
        dependencies: GatewayRuntimeDependencies,
        options: GatewayRuntimeOptions,
    ) -> Result<Self, GatewayRuntimeError> {
        validate_options(options)?;
        let (lifecycle, state) = LifecycleController::new();
        let lifecycle = Arc::new(lifecycle);
        let (client, ingress) = GatewayClient::channel(options.command_capacity, state)
            .map_err(|error| GatewayRuntimeError::new("startup", error.to_string()))?;
        let (control, control_receiver) = mpsc::channel(options.control_capacity);
        let (ready, ready_receiver) = oneshot::channel();
        let task_lifecycle = lifecycle.clone();
        let task = tokio::spawn(async move {
            match AssertUnwindSafe(run_root(
                dependencies,
                options,
                task_lifecycle.clone(),
                ingress,
                control,
                control_receiver,
                ready,
            ))
            .catch_unwind()
            .await
            {
                Ok(result) => result,
                Err(payload) => {
                    let error = GatewayRuntimeError::new("runtime", panic_message(payload));
                    let _ = task_lifecycle.fail(error.stage.clone(), error.cause.clone());
                    Err(error)
                }
            }
        });
        match ready_receiver.await {
            Ok(Ok(())) => Ok(Self {
                client,
                task: Some(task),
            }),
            Ok(Err(error)) => {
                let _ = task.await;
                Err(error)
            }
            Err(_) => match task.await {
                Ok(Err(error)) => Err(error),
                Ok(Ok(_)) => Err(GatewayRuntimeError::new(
                    "startup",
                    "Gateway runtime stopped before reporting readiness",
                )),
                Err(error) => Err(GatewayRuntimeError::new("startup", error.to_string())),
            },
        }
    }

    pub fn client(&self) -> GatewayClient {
        self.client.clone()
    }

    pub async fn shutdown(mut self) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
        self.client
            .shutdown()
            .await
            .map_err(|error| GatewayRuntimeError::new("shutdown", error.to_string()))?;
        self.join_inner().await
    }

    pub async fn join(mut self) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
        self.join_inner().await
    }

    async fn join_inner(&mut self) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
        let task = self.task.take().ok_or_else(|| {
            GatewayRuntimeError::new("join", "Gateway runtime was already joined")
        })?;
        task.await
            .map_err(|error| GatewayRuntimeError::new("runtime", error.to_string()))?
    }
}

async fn run_root(
    dependencies: GatewayRuntimeDependencies,
    options: GatewayRuntimeOptions,
    lifecycle: Arc<LifecycleController>,
    mut ingress: GatewayIngress,
    control: mpsc::Sender<RuntimeControl>,
    control_receiver: mpsc::Receiver<RuntimeControl>,
    ready: oneshot::Sender<Result<(), GatewayRuntimeError>>,
) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
    transition(&lifecycle, GatewayState::Starting)?;
    if let Err(error) = seed_repository(&dependencies).await {
        fail(&lifecycle, &error);
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let restarting = Arc::new(AtomicBool::new(false));
    let services = match RuntimeServices::compose(dependencies, control, restarting.clone()).await {
        Ok(services) => services,
        Err(error) => {
            fail(&lifecycle, &error);
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    if let Err(error) = services.start().await {
        fail(&lifecycle, &error);
        let cleanup_error = services.stop(false).await.err();
        let error = append_cleanup_error(error, cleanup_error);
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    services.send_online_best_effort(&services.site_name).await;
    transition(&lifecycle, GatewayState::Ready)?;
    transition(&lifecycle, GatewayState::Running)?;
    if ready.send(Ok(())).is_err() {
        return orderly_stop(&lifecycle, &mut ingress, services, None, false).await;
    }

    let event = AssertUnwindSafe(run_event_loop(
        &mut ingress,
        &services,
        control_receiver,
        restarting,
        options.max_http_concurrency,
    ))
    .catch_unwind()
    .await;
    match event {
        Ok(Ok(LoopExit::Shutdown(response))) => {
            orderly_stop(&lifecycle, &mut ingress, services, response, false).await
        }
        Ok(Ok(LoopExit::Restart)) => {
            let policy = services.restart_policy;
            orderly_stop(&lifecycle, &mut ingress, services, None, true)
                .await
                .map(|_| GatewayRuntimeExit::RestartRequested(policy))
        }
        Ok(Err(error)) => fatal_stop(&lifecycle, &mut ingress, services, error).await,
        Err(payload) => {
            fatal_stop(
                &lifecycle,
                &mut ingress,
                services,
                GatewayRuntimeError::new("runtime", panic_message(payload)),
            )
            .await
        }
    }
}

async fn seed_repository(
    dependencies: &GatewayRuntimeDependencies,
) -> Result<(), GatewayRuntimeError> {
    dependencies
        .repository
        .ensure_default_local_device_seeded(&dependencies.host_name)
        .await
        .map_err(|error| GatewayRuntimeError::new("seed-local-device", error.to_string()))?;
    dependencies
        .repository
        .ensure_site_settings_initialized(&site_defaults(&dependencies.config))
        .await
        .map_err(|error| GatewayRuntimeError::new("seed-site-settings", error.to_string()))?;
    dependencies
        .repository
        .ensure_agent_settings_initialized()
        .await
        .map_err(|error| GatewayRuntimeError::new("seed-agent-settings", error.to_string()))
}

enum LoopExit {
    Shutdown(Option<oneshot::Sender<Result<(), IpcError>>>),
    Restart,
}

async fn run_event_loop(
    ingress: &mut GatewayIngress,
    services: &RuntimeServices,
    mut control: mpsc::Receiver<RuntimeControl>,
    restarting: Arc<AtomicBool>,
    max_http_concurrency: usize,
) -> Result<LoopExit, GatewayRuntimeError> {
    let mut requests = JoinSet::new();
    let mut restart_timer: Option<Pin<Box<Sleep>>> = None;
    let exit = loop {
        match ingress.try_recv_shutdown() {
            Ok(response) => break Ok(LoopExit::Shutdown(Some(response))),
            Err(mpsc::error::TryRecvError::Disconnected) => {
                break Ok(LoopExit::Shutdown(None));
            }
            Err(mpsc::error::TryRecvError::Empty) => {}
        }
        let (commands, shutdown) = ingress.receivers();
        tokio::select! {
            response = shutdown.recv() => {
                break Ok(LoopExit::Shutdown(response));
            }
            command = commands.recv(), if requests.len() < max_http_concurrency => {
                match command {
                    Some(GatewayCommand::Http { request, response }) => {
                        let handler = services.handler.clone();
                        requests.spawn(async move {
                            let response_value = handler.handle(*request).await;
                            let _ = response.send(Ok(response_value));
                        });
                    }
                    Some(GatewayCommand::OpenWebSocket { response }) => {
                        let result = services
                            .hub
                            .open_session()
                            .map_err(|error| IpcError::Request(error.to_string()));
                        let _ = response.send(result);
                    }
                    Some(GatewayCommand::Shutdown { response }) => {
                        break Ok(LoopExit::Shutdown(Some(response)));
                    }
                    None => break Ok(LoopExit::Shutdown(None)),
                }
            }
            result = requests.join_next(), if !requests.is_empty() => {
                if let Some(Err(error)) = result {
                    break Err(GatewayRuntimeError::new("http", error.to_string()));
                }
            }
            message = control.recv() => {
                match message {
                    Some(RuntimeControl::ScheduleRestart { delay, response }) => {
                        if restart_timer.is_none() {
                            restart_timer = Some(Box::pin(tokio::time::sleep(delay)));
                        }
                        let _ = response.send(());
                    }
                    None => {
                        break Err(GatewayRuntimeError::new(
                            "control",
                            "Gateway runtime control channel closed unexpectedly",
                        ));
                    }
                }
            }
            () = wait_for_restart(&mut restart_timer, &restarting) => {
                break Ok(LoopExit::Restart);
            }
        }
    };
    ingress.close();
    reject_pending(ingress, "Gateway runtime is shutting down").await;
    // The TypeScript runtime detached in-flight fetch handlers when its listener/runtime
    // retired.  Waiting for an arbitrary streaming or remote HTTP handler here would prevent
    // WebSocket/service cleanup and can strand the embedded database behind Companion's outer
    // shutdown deadline.  Stop admitting first, then cancel every owned request task.
    requests.abort_all();
    while let Some(result) = requests.join_next().await {
        if let Err(error) = result {
            if error.is_panic() && exit.is_ok() {
                return Err(GatewayRuntimeError::new("http", error.to_string()));
            }
        }
    }
    exit
}

async fn wait_for_restart(timer: &mut Option<Pin<Box<Sleep>>>, restarting: &AtomicBool) {
    match timer {
        Some(timer) => {
            timer.await;
            restarting.store(true, Ordering::Release);
        }
        None => pending().await,
    }
}

async fn orderly_stop(
    lifecycle: &LifecycleController,
    ingress: &mut GatewayIngress,
    services: RuntimeServices,
    response: Option<oneshot::Sender<Result<(), IpcError>>>,
    restart: bool,
) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
    ingress.close();
    reject_pending(ingress, "Gateway runtime is shutting down").await;
    transition(lifecycle, GatewayState::Draining)?;
    match services.stop(restart).await {
        Ok(()) => {
            transition(lifecycle, GatewayState::Stopped)?;
            if let Some(response) = response {
                let _ = response.send(Ok(()));
            }
            Ok(GatewayRuntimeExit::Stopped)
        }
        Err(error) => {
            fail(lifecycle, &error);
            if let Some(response) = response {
                let _ = response.send(Err(IpcError::Request(error.to_string())));
            }
            Err(error)
        }
    }
}

async fn fatal_stop(
    lifecycle: &LifecycleController,
    ingress: &mut GatewayIngress,
    services: RuntimeServices,
    error: GatewayRuntimeError,
) -> Result<GatewayRuntimeExit, GatewayRuntimeError> {
    fail(lifecycle, &error);
    ingress.close();
    reject_pending(ingress, &error.to_string()).await;
    let cleanup_error = services.stop(false).await.err();
    Err(append_cleanup_error(error, cleanup_error))
}

async fn reject_pending(ingress: &mut GatewayIngress, message: &str) {
    while let Ok(response) = ingress.try_recv_shutdown() {
        let _ = response.send(Err(IpcError::Request(message.to_owned())));
    }
    while let Some(command) = ingress.recv().await {
        let error = || IpcError::Request(message.to_owned());
        match command {
            GatewayCommand::Http { response, .. } => {
                let _ = response.send(Err(error()));
            }
            GatewayCommand::OpenWebSocket { response } => {
                let _ = response.send(Err(error()));
            }
            GatewayCommand::Shutdown { response } => {
                let _ = response.send(Err(error()));
            }
        }
    }
}

fn transition(
    lifecycle: &LifecycleController,
    state: GatewayState,
) -> Result<(), GatewayRuntimeError> {
    lifecycle
        .transition(state)
        .map_err(|error| GatewayRuntimeError::new("lifecycle", error.to_string()))
}

fn fail(lifecycle: &LifecycleController, error: &GatewayRuntimeError) {
    let _ = lifecycle.fail(error.stage.clone(), error.cause.clone());
}

fn append_cleanup_error(
    mut error: GatewayRuntimeError,
    cleanup: Option<GatewayRuntimeError>,
) -> GatewayRuntimeError {
    if let Some(cleanup) = cleanup {
        error.cause = format!("{}; cleanup also failed: {cleanup}", error.cause);
    }
    error
}

fn validate_options(options: GatewayRuntimeOptions) -> Result<(), GatewayRuntimeError> {
    if options.command_capacity == 0
        || options.control_capacity == 0
        || options.max_http_concurrency == 0
    {
        return Err(GatewayRuntimeError::new(
            "configuration",
            "Gateway runtime queue capacities and HTTP concurrency must be positive",
        ));
    }
    Ok(())
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "Gateway runtime task panicked".to_owned())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn restart_flag_changes_only_after_the_scheduled_delay() {
        let restarting = AtomicBool::new(false);
        let mut timer = Some(Box::pin(tokio::time::sleep(Duration::from_millis(50))));

        assert!(!restarting.load(Ordering::Acquire));
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            wait_for_restart(&mut timer, &restarting),
        )
        .await
        .is_err());
        assert!(!restarting.load(Ordering::Acquire));

        wait_for_restart(&mut timer, &restarting).await;
        assert!(restarting.load(Ordering::Acquire));
    }
}
