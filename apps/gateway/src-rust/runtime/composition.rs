use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;

use crate::agent::{
    AgentRunConfig, AgentRunDependencies, AgentRunService, AgentSessionCoordinator,
    AgentSupervisor, AgentSupervisorDependencies, AgentToolRegistryFactory, AgentWebTools,
    RepositoryAgentWebSearch, ReqwestAgentWebHttpTransport, SystemAgentEnvironmentSource,
    TmuxAgentTerminalProvider, TokioAgentClock, TokioDnsResolver,
};
use crate::config::{GatewayConfig, GatewayRestartPolicy, GATEWAY_VERSION};
use crate::database::repository::RepositorySiteSettingsDefaults;
use crate::events::{
    EventClock, EventNotifier, GatewayTmuxLifecycleSink, NotificationChannel,
    RepositoryEventConfig, ReqwestWebhookTransport, SystemEventClock, TelegramChannel,
    WebhookChannel, WeixinChannel, WsBroadcastChannel,
};
use crate::http::HttpHandler;
use crate::i18n::{GatewayI18n, GatewayLocale};
use crate::llm::{ProviderRegistry, ReqwestModelsHttpTransport};
use crate::push::{
    ConnectionAlertNotifier, ConnectionAlertNotifierDependencies, DeviceSessionRuntimeHost,
    PushSupervisor, PushSupervisorDependencies, RepositoryPushStore, SystemPushScheduler,
};
use crate::telegram::{
    GatewayTelegramMessageFormatter, ReqwestTelegramTransportFactory, TelegramService,
    TelegramServiceDependencies,
};
use crate::tmux::{
    DeviceSessionRuntime, ManagedTmuxRuntime, RepositoryTmuxRuntimeConfig,
    RepositoryTmuxRuntimeFactory, SpawnExecutor, TmuxRuntimeRegistry,
};
use crate::watch::{
    GatewayWatchRuntime, GatewayWatchRuntimeDependencies, WatchService, WatchServiceConfig,
};
use crate::weixin::{
    GatewayWeixinMessageFormatter, ReqwestWeixinIlinkTransport, WeixinService,
    WeixinServiceDependencies,
};
use crate::ws::{GatewayWsHub, GatewayWsHubConfig, GatewayWsHubDependencies};

use super::agent_notifications::GatewayAgentNotificationSink;
use super::control::RuntimeControl;
use super::deferred_lifecycle::DeferredTmuxLifecycleSink;
use super::http_runtime::{GatewayHttpRuntime, GatewayHttpRuntimeDependencies};
use super::ports::{GatewayRuntimeDependencies, GatewayRuntimeError};

pub(crate) struct RuntimeServices {
    pub(crate) handler: HttpHandler,
    pub(crate) hub: Arc<GatewayWsHub>,
    pub(crate) site_name: String,
    pub(crate) restart_policy: GatewayRestartPolicy,
    repository: crate::database::repository::Repository,
    watch: WatchService,
    agent: Arc<AgentSupervisor>,
    push: Arc<PushSupervisor>,
    runtimes: Arc<TmuxRuntimeRegistry<DeviceSessionRuntime>>,
    telegram: Arc<TelegramService>,
    weixin: Arc<WeixinService>,
}

pub(crate) struct RequiredLocalRuntimeLease {
    device_id: String,
    runtime: Arc<DeviceSessionRuntime>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceLifecycleOperation {
    RefreshTelegram,
    RefreshWeixin,
    StartPush,
    StartAgent,
    StartWatch,
    CloseWebSockets { restart: bool },
    StopWatch,
    StopAgent,
    StopPush,
    ShutdownTmuxRuntimes,
    StopTelegram,
    StopWeixin,
}

#[async_trait]
trait RuntimeServiceLifecycle: Sync {
    async fn apply(&self, operation: ServiceLifecycleOperation) -> Result<(), GatewayRuntimeError>;
}

impl RuntimeServices {
    pub(crate) async fn compose(
        dependencies: GatewayRuntimeDependencies,
        control: tokio::sync::mpsc::Sender<RuntimeControl>,
        restarting: Arc<AtomicBool>,
    ) -> Result<Self, GatewayRuntimeError> {
        let GatewayRuntimeDependencies {
            repository,
            config,
            master_key,
            host_name: _,
            environment,
            spawn_policy,
            tmux_transport_factory,
            file_runtime,
            agent_model,
            watch_model,
            watch_assist,
            system_info,
        } = dependencies;
        let defaults = site_defaults(&config);
        let settings = repository
            .get_site_settings(&defaults)
            .await
            .map_err(|error| runtime_error("settings", error))?;
        let site_name = settings.site_name.clone();
        let restart_policy = config.restart_policy;
        let i18n = GatewayI18n::new(
            GatewayLocale::parse(&settings.language).unwrap_or(GatewayLocale::EnUs),
        );
        let telegram = Arc::new(TelegramService::new(TelegramServiceDependencies {
            store: Arc::new(repository.clone()),
            master_key: master_key.clone(),
            transport_factory: Arc::new(ReqwestTelegramTransportFactory::default()),
            formatter: Arc::new(GatewayTelegramMessageFormatter::new(i18n.clone())),
        }));
        let weixin = Arc::new(WeixinService::new(WeixinServiceDependencies {
            store: Arc::new(repository.clone()),
            master_key: master_key.clone(),
            transport: Arc::new(ReqwestWeixinIlinkTransport::default()),
            formatter: Arc::new(GatewayWeixinMessageFormatter::new(i18n.clone())),
        }));

        let deferred_lifecycle = Arc::new(DeferredTmuxLifecycleSink::default());
        let tmux_config = RepositoryTmuxRuntimeConfig {
            tmux_bin: config.tmux_bin.clone(),
            tmux_socket: config.tmux_socket.clone(),
            tmux_term_program: config.tmux_term_program.clone(),
            tmux_window_style: config.tmux_window_style.clone(),
            allow_passthrough: config.tmux_allow_passthrough,
            enable_control_mode: true,
            environment: environment.clone(),
        };
        let factory = RepositoryTmuxRuntimeFactory::with_transport_factory(
            repository.clone(),
            master_key.clone(),
            spawn_policy.clone(),
            tmux_config,
            tmux_transport_factory,
        )
        .with_lifecycle_sink(deferred_lifecycle.clone());
        let runtimes = Arc::new(TmuxRuntimeRegistry::new(Arc::new(factory)));
        let mut hub_config = GatewayWsHubConfig::new(GATEWAY_VERSION);
        hub_config.initial_theme = match settings.theme.as_str() {
            "dark" => Some(crate::tmux::ThemeMode::Dark),
            "light" => Some(crate::tmux::ThemeMode::Light),
            _ => None,
        };
        let hub = Arc::new(
            GatewayWsHub::new(
                hub_config,
                GatewayWsHubDependencies {
                    runtimes: runtimes.clone(),
                    repository: repository.clone(),
                    site_settings_defaults: defaults.clone(),
                },
            )
            .map_err(|error| runtime_error("websocket-hub", error))?,
        );

        let event_config = Arc::new(RepositoryEventConfig::new(
            repository.clone(),
            defaults.clone(),
        ));
        let event_clock = Arc::new(SystemEventClock);
        let notifier = Arc::new(build_event_notifier(
            &config,
            event_config,
            event_clock,
            telegram.clone(),
            weixin.clone(),
            hub.clone(),
            i18n.clone(),
        )?);
        deferred_lifecycle
            .bind(Arc::new(GatewayTmuxLifecycleSink::new(
                repository.clone(),
                defaults.clone(),
                notifier.clone(),
                tokio::runtime::Handle::current(),
            )))
            .map_err(|error| runtime_error("tmux-lifecycle", error))?;

        let notifications = Arc::new(GatewayAgentNotificationSink::new(
            repository.clone(),
            defaults.clone(),
            runtimes.clone(),
            notifier.clone(),
            telegram.clone(),
            i18n.clone(),
        ));
        let providers = Arc::new(ProviderRegistry::new(
            repository.clone(),
            master_key.clone(),
        ));
        let web_transport = Arc::new(ReqwestAgentWebHttpTransport::default());
        let web_tools = Arc::new(AgentWebTools::new(
            Arc::new(TokioDnsResolver),
            web_transport,
            Some(Arc::new(RepositoryAgentWebSearch::new(
                repository.clone(),
                master_key.clone(),
            ))),
            config.agent_allow_private_fetch,
        ));
        let tool_factory = Arc::new(AgentToolRegistryFactory::new(
            Some(Arc::new(TmuxAgentTerminalProvider::new(runtimes.clone()))),
            web_tools,
        ));
        let coordinator = Arc::new(AgentSessionCoordinator::default());
        let run_service = Arc::new(AgentRunService::new(
            AgentRunDependencies {
                store: Arc::new(repository.clone()),
                providers,
                model: agent_model,
                tools: tool_factory,
                environment: Arc::new(SystemAgentEnvironmentSource),
                events: hub.clone(),
                notifications: notifications.clone(),
                clock: Arc::new(TokioAgentClock),
                coordinator: coordinator.clone(),
            },
            AgentRunConfig::default(),
        ));
        let agent = Arc::new(AgentSupervisor::new(AgentSupervisorDependencies {
            store: Arc::new(repository.clone()),
            launcher: run_service,
            events: hub.clone(),
            notifications,
            coordinator,
        }));
        hub.set_agent_sync_provider(agent.clone());

        let push_store = Arc::new(RepositoryPushStore::new(
            repository.clone(),
            defaults.clone(),
        ));
        let alerts = ConnectionAlertNotifier::new(ConnectionAlertNotifierDependencies {
            store: push_store.clone(),
            translator: Arc::new(i18n.clone()),
            broadcaster: Some(hub.clone()),
            event_sink: Some(notifier.clone()),
            telegram: Some(telegram.clone()),
            clock: Arc::new(SystemEventClock),
        });
        let push = Arc::new(PushSupervisor::new(
            PushSupervisorDependencies::with_default_reconnect_delay(
                push_store,
                Arc::new(DeviceSessionRuntimeHost::new(runtimes.clone())),
                alerts.clone(),
                notifier.clone(),
                Some(agent.clone()),
                Arc::new(i18n.clone()),
                Arc::new(SystemPushScheduler),
            ),
        ));
        let watch_runtime = Arc::new(GatewayWatchRuntime::new(GatewayWatchRuntimeDependencies {
            runtimes: runtimes.clone(),
            notifications: notifier.clone(),
            watch_events: hub.clone(),
            messages: Arc::new(i18n.clone()),
            model_generator: Some(watch_model),
            device_close: agent.clone(),
        }));
        let watch = WatchService::new(
            repository.clone(),
            watch_runtime,
            WatchServiceConfig::new(defaults.clone()),
        );
        let http_runtime = Arc::new(GatewayHttpRuntime::new(GatewayHttpRuntimeDependencies {
            repository: repository.clone(),
            defaults,
            config: config.clone(),
            runtimes: runtimes.clone(),
            push: push.clone(),
            alerts,
            hub: hub.clone(),
            i18n,
            watch_assist,
            system_info,
            control,
            restarting,
            spawn_executor: SpawnExecutor::new(spawn_policy),
            environment,
        }));
        let handler = HttpHandler::with_master_key(
            repository.clone(),
            config,
            master_key,
            http_runtime,
            file_runtime,
        )
        .with_watch_service(watch.clone())
        .with_models_transport(Arc::new(ReqwestModelsHttpTransport::default()))
        .with_agent_service(agent.clone())
        .with_telegram_service(telegram.clone())
        .with_weixin_service(weixin.clone());

        Ok(Self {
            handler,
            hub,
            site_name,
            restart_policy,
            repository,
            watch,
            agent,
            push,
            runtimes,
            telegram,
            weixin,
        })
    }

    pub(crate) async fn acquire_required_local_runtime(
        &self,
    ) -> Result<RequiredLocalRuntimeLease, GatewayRuntimeError> {
        let devices = self
            .repository
            .get_all_devices()
            .await
            .map_err(|error| runtime_error("required-local-tmux", error))?;
        let device_id = select_required_local_device_id(
            devices
                .iter()
                .map(|device| (device.id.as_str(), device.r#type.as_str())),
        )
        .ok_or_else(|| {
            GatewayRuntimeError::new("required-local-tmux", "no local device configured")
        })?;
        let runtime = acquire_required_local_runtime(&self.runtimes, &device_id).await?;
        Ok(RequiredLocalRuntimeLease { device_id, runtime })
    }

    pub(crate) async fn release_required_local_runtime(&self, lease: RequiredLocalRuntimeLease) {
        self.runtimes
            .release(&lease.device_id, Some(&lease.runtime))
            .await;
    }

    pub(crate) async fn start(&self) -> Result<(), GatewayRuntimeError> {
        run_start_sequence(self).await
    }

    pub(crate) async fn send_online_best_effort(&self, site_name: &str) {
        if let Err(error) = self.telegram.send_gateway_online_message(site_name).await {
            tracing::error!(%error, "failed to push Gateway startup message");
            return;
        }
        if let Err(error) = self.weixin.send_gateway_online_message(site_name).await {
            tracing::error!(%error, "failed to push Gateway startup message");
        }
    }

    pub(crate) async fn stop(&self, restart: bool) -> Result<(), GatewayRuntimeError> {
        run_stop_sequence(self, restart).await
    }
}

#[async_trait]
impl RuntimeServiceLifecycle for RuntimeServices {
    async fn apply(&self, operation: ServiceLifecycleOperation) -> Result<(), GatewayRuntimeError> {
        match operation {
            ServiceLifecycleOperation::RefreshTelegram => self
                .telegram
                .refresh()
                .await
                .map_err(|error| runtime_error("telegram", error)),
            ServiceLifecycleOperation::RefreshWeixin => self
                .weixin
                .refresh()
                .await
                .map_err(|error| runtime_error("weixin", error)),
            ServiceLifecycleOperation::StartPush => self
                .push
                .start()
                .await
                .map_err(|error| runtime_error("push", error)),
            ServiceLifecycleOperation::StartAgent => self
                .agent
                .start()
                .await
                .map_err(|error| runtime_error("agent", error)),
            ServiceLifecycleOperation::StartWatch => self
                .watch
                .start()
                .await
                .map_err(|error| runtime_error("watch", error)),
            ServiceLifecycleOperation::CloseWebSockets { restart } => {
                if restart {
                    self.hub
                        .close_all(
                            crate::config::RUNTIME_RESTART_CLOSE_CODE,
                            crate::config::RUNTIME_RESTART_CLOSE_REASON,
                        )
                        .await;
                } else {
                    self.hub.stop_all().await;
                }
                Ok(())
            }
            ServiceLifecycleOperation::StopWatch => {
                self.watch.stop().await;
                Ok(())
            }
            ServiceLifecycleOperation::StopAgent => {
                self.agent.stop().await;
                Ok(())
            }
            ServiceLifecycleOperation::StopPush => {
                self.push.stop_all().await;
                Ok(())
            }
            ServiceLifecycleOperation::ShutdownTmuxRuntimes => {
                self.runtimes.shutdown_all().await;
                Ok(())
            }
            ServiceLifecycleOperation::StopTelegram => self
                .telegram
                .stop_all()
                .await
                .map_err(|error| runtime_error("telegram-stop", error)),
            ServiceLifecycleOperation::StopWeixin => self
                .weixin
                .stop_all()
                .await
                .map_err(|error| runtime_error("weixin-stop", error)),
        }
    }
}

async fn run_start_sequence(
    services: &(impl RuntimeServiceLifecycle + ?Sized),
) -> Result<(), GatewayRuntimeError> {
    for operation in [
        ServiceLifecycleOperation::RefreshTelegram,
        ServiceLifecycleOperation::RefreshWeixin,
        ServiceLifecycleOperation::StartPush,
        ServiceLifecycleOperation::StartAgent,
        ServiceLifecycleOperation::StartWatch,
    ] {
        services.apply(operation).await?;
    }
    Ok(())
}

async fn run_stop_sequence(
    services: &(impl RuntimeServiceLifecycle + ?Sized),
    restart: bool,
) -> Result<(), GatewayRuntimeError> {
    let mut first_error = None;
    for operation in [
        ServiceLifecycleOperation::CloseWebSockets { restart },
        ServiceLifecycleOperation::StopWatch,
        ServiceLifecycleOperation::StopAgent,
        ServiceLifecycleOperation::StopPush,
        ServiceLifecycleOperation::ShutdownTmuxRuntimes,
        ServiceLifecycleOperation::StopTelegram,
        ServiceLifecycleOperation::StopWeixin,
    ] {
        if let Err(error) = services.apply(operation).await {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn build_event_notifier(
    config: &GatewayConfig,
    event_config: Arc<RepositoryEventConfig>,
    clock: Arc<SystemEventClock>,
    telegram: Arc<TelegramService>,
    weixin: Arc<WeixinService>,
    hub: Arc<GatewayWsHub>,
    i18n: GatewayI18n,
) -> Result<EventNotifier, GatewayRuntimeError> {
    let mut notifier = EventNotifier::new(event_config.clone(), clock.clone());
    let disabled = config
        .disabled_notification_channels
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let now_millis = {
        let clock = clock.clone();
        Arc::new(move || clock.now_millis()) as Arc<dyn Fn() -> u64 + Send + Sync>
    };
    let channels: [(&str, Arc<dyn NotificationChannel>); 4] = [
        (
            "webhook",
            Arc::new(WebhookChannel::new(
                event_config.clone(),
                Arc::new(ReqwestWebhookTransport::new(
                    reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                        .unwrap_or_else(|_| reqwest::Client::new()),
                )),
                now_millis.clone(),
            )),
        ),
        (
            "telegram",
            Arc::new(TelegramChannel::new(
                event_config.clone(),
                telegram,
                i18n.clone(),
            )),
        ),
        (
            "weixin",
            Arc::new(WeixinChannel::new(event_config, weixin, i18n)),
        ),
        (
            "ws-broadcast",
            Arc::new(WsBroadcastChannel::new(hub, now_millis)),
        ),
    ];
    for (id, channel) in channels {
        if disabled.contains(id) {
            continue;
        }
        notifier
            .register_channel(channel)
            .map_err(|error| runtime_error("notification-channels", error))?;
    }
    Ok(notifier)
}

pub(crate) fn site_defaults(config: &GatewayConfig) -> RepositorySiteSettingsDefaults {
    RepositorySiteSettingsDefaults {
        site_name: config.site_name_default.clone(),
        site_url: config.base_url.clone(),
        bell_throttle_seconds: config.bell_throttle_seconds_default as i64,
        notification_throttle_seconds: config.notification_throttle_seconds_default as i64,
        ssh_reconnect_max_retries: config.ssh_reconnect_max_retries_default as i64,
        ssh_reconnect_delay_seconds: config.ssh_reconnect_delay_seconds_default as i64,
        language: config.language_default.clone(),
    }
}

fn select_required_local_device_id<'a, I>(devices: I) -> Option<String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    devices
        .into_iter()
        .find(|(_, device_type)| *device_type == "local")
        .map(|(id, _)| id.to_owned())
}

async fn acquire_required_local_runtime<R>(
    registry: &TmuxRuntimeRegistry<R>,
    device_id: &str,
) -> Result<Arc<R>, GatewayRuntimeError>
where
    R: ManagedTmuxRuntime,
{
    registry.acquire(device_id).await.map_err(|error| {
        GatewayRuntimeError::new("required-local-tmux", format!("{error}: {device_id}"))
    })
}

fn runtime_error(stage: &'static str, error: impl std::fmt::Display) -> GatewayRuntimeError {
    GatewayRuntimeError::new(stage, error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::runtime::ports::GatewayRuntimeOptions;
    use crate::tmux::RuntimeRegistryError;

    #[derive(Default)]
    struct RecordingLifecycle {
        operations: Mutex<Vec<ServiceLifecycleOperation>>,
    }

    #[async_trait]
    impl RuntimeServiceLifecycle for RecordingLifecycle {
        async fn apply(
            &self,
            operation: ServiceLifecycleOperation,
        ) -> Result<(), GatewayRuntimeError> {
            self.operations
                .lock()
                .expect("lifecycle operations lock")
                .push(operation);
            if operation == ServiceLifecycleOperation::StopTelegram {
                return Err(GatewayRuntimeError::new(
                    "telegram-stop",
                    "injected stop failure",
                ));
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn service_lifecycle_keeps_the_start_and_complete_reverse_stop_order() {
        let services = RecordingLifecycle::default();
        run_start_sequence(&services)
            .await
            .expect("run start sequence");
        assert_eq!(
            *services
                .operations
                .lock()
                .expect("lifecycle operations lock"),
            [
                ServiceLifecycleOperation::RefreshTelegram,
                ServiceLifecycleOperation::RefreshWeixin,
                ServiceLifecycleOperation::StartPush,
                ServiceLifecycleOperation::StartAgent,
                ServiceLifecycleOperation::StartWatch,
            ]
        );

        services
            .operations
            .lock()
            .expect("lifecycle operations lock")
            .clear();
        let error = run_stop_sequence(&services, true)
            .await
            .expect_err("injected Telegram stop failure");
        assert_eq!(error.stage, "telegram-stop");
        assert_eq!(
            *services
                .operations
                .lock()
                .expect("lifecycle operations lock"),
            [
                ServiceLifecycleOperation::CloseWebSockets { restart: true },
                ServiceLifecycleOperation::StopWatch,
                ServiceLifecycleOperation::StopAgent,
                ServiceLifecycleOperation::StopPush,
                ServiceLifecycleOperation::ShutdownTmuxRuntimes,
                ServiceLifecycleOperation::StopTelegram,
                ServiceLifecycleOperation::StopWeixin,
            ]
        );
    }

    #[test]
    fn default_options_do_not_require_a_local_runtime() {
        assert!(!GatewayRuntimeOptions::default().require_local_tmux_runtime);
    }

    #[test]
    fn required_local_selection_picks_the_first_local_device() {
        let selected = select_required_local_device_id([
            ("ssh-1", "ssh"),
            ("local-1", "local"),
            ("local-2", "local"),
        ]);
        assert_eq!(selected.as_deref(), Some("local-1"));
    }

    #[test]
    fn required_local_selection_fails_without_a_local_device() {
        assert_eq!(
            select_required_local_device_id([("ssh-1", "ssh"), ("ssh-2", "ssh")]),
            None
        );
    }

    #[derive(Debug)]
    struct TestRuntime {
        shutdowns: AtomicUsize,
    }
    #[async_trait]
    impl ManagedTmuxRuntime for TestRuntime {
        fn is_terminated(&self) -> bool {
            false
        }

        async fn shutdown(&self) {
            self.shutdowns.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[tokio::test]
    async fn required_acquire_error_uses_required_local_tmux_stage() {
        let registry: TmuxRuntimeRegistry<TestRuntime> =
            TmuxRuntimeRegistry::new(Arc::new(|device_id: String| async move {
                Err(RuntimeRegistryError::new(format!(
                    "tmux_runtime_start_failed: {device_id}"
                )))
            }));
        let error = acquire_required_local_runtime(&registry, "local-1")
            .await
            .expect_err("acquire failure must block readiness");
        assert_eq!(error.stage, "required-local-tmux");
        assert!(error.cause.contains("tmux_runtime_start_failed"));
        assert!(error.cause.contains("local-1"));
    }

    #[tokio::test]
    async fn required_lease_is_not_shut_down_before_explicit_release() {
        let registry = TmuxRuntimeRegistry::new(Arc::new(|_: String| async {
            Ok(Arc::new(TestRuntime {
                shutdowns: AtomicUsize::new(0),
            }))
        }));
        let runtime = acquire_required_local_runtime(&registry, "local-1")
            .await
            .expect("required acquire succeeds");
        assert_eq!(runtime.shutdowns.load(Ordering::Acquire), 0);
        assert!(registry.peek("local-1").await.is_some());
        registry.release("local-1", Some(&runtime)).await;
        assert_eq!(runtime.shutdowns.load(Ordering::Acquire), 1);
    }
}
