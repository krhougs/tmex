use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock, Weak};

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::future::join_all;
use tokio::sync::{oneshot, Mutex, Semaphore};

use crate::crypto::{CryptoContext, MasterKey};
use crate::database::repository::{UpsertWeixinUserInput, WeixinAccountUpdate};
use crate::entity::{weixin_account_users, weixin_accounts};
use crate::i18n::GatewayI18n;

use super::{
    weixin_cancellation_pair, StartWeixinLoginResponse, WeixinBaseUrl, WeixinBotToken,
    WeixinCancelHandle, WeixinClient, WeixinClientError, WeixinCredentials, WeixinIlinkTransport,
    WeixinInboundMessage, WeixinLoginOptions, WeixinLoginStatus, WeixinLoginStatusResponse,
    WeixinPollCallbackError, WeixinPollObserver, WeixinQrcode, WeixinServiceError,
    WeixinStartOptions, WeixinStore, KEEPALIVE_INTERVAL, KEEPALIVE_SWEEP_INTERVAL,
};

pub trait WeixinMessageFormatter: Send + Sync {
    fn gateway_online(&self, site_name: &str) -> String;
    fn keepalive_prompt(&self) -> String;
    fn account_not_running(&self) -> String;
    fn user_not_found(&self) -> String;
}

#[derive(Clone, Debug)]
pub struct GatewayWeixinMessageFormatter {
    i18n: GatewayI18n,
}

impl GatewayWeixinMessageFormatter {
    pub fn new(i18n: GatewayI18n) -> Self {
        Self { i18n }
    }
}

impl WeixinMessageFormatter for GatewayWeixinMessageFormatter {
    fn gateway_online(&self, site_name: &str) -> String {
        self.i18n.translate_with(
            "weixin.gatewayOnline",
            &HashMap::from([("siteName", site_name.to_owned())]),
        )
    }

    fn keepalive_prompt(&self) -> String {
        self.i18n.translate("weixin.keepalivePrompt")
    }

    fn account_not_running(&self) -> String {
        self.i18n.translate("weixin.accountNotRunning")
    }

    fn user_not_found(&self) -> String {
        self.i18n.translate("weixin.userNotFound")
    }
}

pub struct WeixinServiceDependencies {
    pub store: Arc<dyn WeixinStore>,
    pub master_key: MasterKey,
    pub transport: Arc<dyn WeixinIlinkTransport>,
    pub formatter: Arc<dyn WeixinMessageFormatter>,
}

#[derive(Clone)]
pub struct WeixinService {
    inner: Arc<WeixinServiceInner>,
}

struct WeixinServiceInner {
    dependencies: WeixinServiceDependencies,
    lifecycle: Semaphore,
    running_accounts: Mutex<HashMap<String, RunningAccount>>,
    login_sessions: Mutex<HashMap<String, LoginSession>>,
    session_expired_notified: Mutex<HashSet<String>>,
    keepalive_task: Mutex<Option<KeepaliveTask>>,
    last_keepalive_at: Mutex<HashMap<String, i64>>,
    stopping: AtomicBool,
    next_generation: AtomicU64,
}

#[derive(Clone)]
struct RunningAccount {
    credentials: WeixinCredentials,
    client: Arc<WeixinClient>,
    generation: u64,
}

struct LoginSession {
    state: Arc<StdRwLock<LoginSessionState>>,
    cancel: WeixinCancelHandle,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct LoginSessionState {
    status: WeixinLoginStatus,
    message: Option<String>,
    qrcode_url: String,
    qrcode_id: String,
}

struct KeepaliveTask {
    cancel: WeixinCancelHandle,
    task: tokio::task::JoinHandle<()>,
}

impl fmt::Debug for WeixinService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WeixinService")
    }
}

#[async_trait]
pub trait WeixinServicePort: Send + Sync {
    async fn refresh(&self) -> Result<(), WeixinServiceError>;
    async fn send_gateway_online_message(&self, site_name: &str) -> Result<(), WeixinServiceError>;
    async fn send_to_authorized_users(&self, text: String) -> Result<(), WeixinServiceError>;
    async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError>;
    async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError>;
    async fn start_login(
        &self,
        account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinServiceError>;
    async fn get_login_status(
        &self,
        account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinServiceError>;
    async fn stop_all(&self) -> Result<(), WeixinServiceError>;
}

impl WeixinService {
    pub fn new(dependencies: WeixinServiceDependencies) -> Self {
        Self {
            inner: Arc::new(WeixinServiceInner {
                dependencies,
                lifecycle: Semaphore::new(1),
                running_accounts: Mutex::new(HashMap::new()),
                login_sessions: Mutex::new(HashMap::new()),
                session_expired_notified: Mutex::new(HashSet::new()),
                keepalive_task: Mutex::new(None),
                last_keepalive_at: Mutex::new(HashMap::new()),
                stopping: AtomicBool::new(false),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub async fn refresh(&self) -> Result<(), WeixinServiceError> {
        let _lifecycle = self
            .inner
            .lifecycle
            .acquire()
            .await
            .map_err(|_| WeixinServiceError::ServiceStopping)?;
        if self.inner.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        self.ensure_keepalive_task().await;
        self.refresh_locked().await
    }

    pub async fn send_gateway_online_message(
        &self,
        site_name: &str,
    ) -> Result<(), WeixinServiceError> {
        self.send_to_authorized_users(self.inner.dependencies.formatter.gateway_online(site_name))
            .await
    }

    pub async fn send_to_authorized_users(&self, text: String) -> Result<(), WeixinServiceError> {
        let running = self
            .inner
            .running_accounts
            .lock()
            .await
            .iter()
            .map(|(account_id, running)| (account_id.clone(), running.clone()))
            .collect::<Vec<_>>();
        for (account_id, running) in running {
            let users = self
                .inner
                .dependencies
                .store
                .authorized_users(&account_id)
                .await?;
            for user in users {
                if !self.send_to_user(&account_id, &running, &user, &text).await {
                    break;
                }
            }
        }
        Ok(())
    }

    pub async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError> {
        let client = self
            .inner
            .running_accounts
            .lock()
            .await
            .get(account_id)
            .map(|running| running.client.clone())
            .ok_or_else(|| WeixinServiceError::AccountNotRunning {
                account_id: account_id.to_owned(),
                message: self.inner.dependencies.formatter.account_not_running(),
            })?;
        client.send_text(user_id, text, None).await?;
        Ok(())
    }

    pub async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError> {
        let user = self
            .inner
            .dependencies
            .store
            .authorized_users(account_id)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| WeixinServiceError::UserNotFound {
                account_id: account_id.to_owned(),
                message: self.inner.dependencies.formatter.user_not_found(),
            })?;
        self.send_test_message(account_id, &user.user_id, text)
            .await
    }

    pub async fn start_login(
        &self,
        account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinServiceError> {
        let receiver = {
            let _lifecycle = self
                .inner
                .lifecycle
                .acquire()
                .await
                .map_err(|_| WeixinServiceError::ServiceStopping)?;
            if self.inner.stopping.load(Ordering::Acquire) {
                return Err(WeixinServiceError::ServiceStopping);
            }
            if self
                .inner
                .dependencies
                .store
                .account_by_id(account_id)
                .await?
                .is_none()
            {
                return Err(WeixinServiceError::AccountNotFound {
                    account_id: account_id.to_owned(),
                });
            }
            let previous = self.inner.login_sessions.lock().await.remove(account_id);
            if let Some(previous) = previous {
                stop_login_session(previous).await;
            }

            let client = Arc::new(WeixinClient::new(
                self.inner.dependencies.transport.clone(),
                None,
            ));
            let state = Arc::new(StdRwLock::new(LoginSessionState {
                status: WeixinLoginStatus::Pending,
                message: None,
                qrcode_url: String::new(),
                qrcode_id: String::new(),
            }));
            let (cancel, cancellation) = weixin_cancellation_pair();
            let (first_qrcode, receiver) = oneshot::channel();
            let first_qrcode = Arc::new(StdMutex::new(Some(first_qrcode)));
            let callback_state = state.clone();
            let callback_sender = first_qrcode.clone();
            let on_qrcode = Arc::new(move |qrcode: WeixinQrcode| {
                {
                    let mut state = callback_state
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.qrcode_url.clone_from(&qrcode.url);
                    state.qrcode_id.clone_from(&qrcode.qrcode_id);
                    state.status = WeixinLoginStatus::Pending;
                    state.message = None;
                }
                if let Some(sender) = callback_sender
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    let _ = sender.send(Ok(StartWeixinLoginResponse {
                        qrcode_url: qrcode.url,
                        qrcode_id: qrcode.qrcode_id,
                    }));
                }
            });

            let service = self.clone();
            let account_id_owned = account_id.to_owned();
            let task_state = state.clone();
            let task = tokio::spawn(async move {
                let result = client
                    .login(WeixinLoginOptions::new(on_qrcode, cancellation))
                    .await;
                match result {
                    Ok(credentials) => {
                        let result = service.persist_login(&account_id_owned, &credentials).await;
                        match result {
                            Ok(()) => {
                                task_state
                                    .write()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .status = WeixinLoginStatus::Confirmed;
                                if let Err(error) = service.refresh().await {
                                    set_login_error(&task_state, &error.to_string(), false);
                                }
                            }
                            Err(error) => set_login_error(&task_state, &error.to_string(), false),
                        }
                    }
                    Err(error) => {
                        let expired = matches!(
                            error,
                            WeixinClientError::QrcodeRefreshLimit
                                | WeixinClientError::LoginTimedOut
                        );
                        set_login_error(&task_state, &error.to_string(), expired);
                        if let Some(sender) = first_qrcode
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .take()
                        {
                            let _ = sender.send(Err(error));
                        }
                    }
                }
            });
            self.inner.login_sessions.lock().await.insert(
                account_id.to_owned(),
                LoginSession {
                    state,
                    cancel,
                    task,
                },
            );
            receiver
        };

        match receiver.await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(WeixinServiceError::LoginUnavailable),
        }
    }

    pub async fn get_login_status(
        &self,
        account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinServiceError> {
        let account = self
            .inner
            .dependencies
            .store
            .account_by_id(account_id)
            .await?;
        let logged_in = account
            .as_ref()
            .is_some_and(|account| account.bot_token_enc.is_some());
        let state = self
            .inner
            .login_sessions
            .lock()
            .await
            .get(account_id)
            .map(|session| {
                session
                    .state
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            });
        Ok(match state {
            Some(state) => WeixinLoginStatusResponse {
                status: state.status,
                logged_in,
                message: state.message,
            },
            None => WeixinLoginStatusResponse {
                status: if logged_in {
                    WeixinLoginStatus::Confirmed
                } else {
                    WeixinLoginStatus::Pending
                },
                logged_in,
                message: None,
            },
        })
    }

    pub async fn stop_all(&self) -> Result<(), WeixinServiceError> {
        self.inner.stopping.store(true, Ordering::Release);
        let (keepalive, login_sessions, running_accounts) = {
            let _lifecycle = self
                .inner
                .lifecycle
                .acquire()
                .await
                .map_err(|_| WeixinServiceError::ServiceStopping)?;
            let keepalive = self.inner.keepalive_task.lock().await.take();
            let login_sessions = self
                .inner
                .login_sessions
                .lock()
                .await
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            let running_accounts = self
                .inner
                .running_accounts
                .lock()
                .await
                .drain()
                .map(|(_, running)| running)
                .collect::<Vec<_>>();
            (keepalive, login_sessions, running_accounts)
        };

        if let Some(keepalive) = keepalive {
            keepalive.cancel.cancel();
            keepalive.task.abort();
            let _ = keepalive.task.await;
        }
        for session in &login_sessions {
            session.cancel.cancel();
            session.task.abort();
        }
        for session in login_sessions {
            let _ = session.task.await;
        }
        join_all(
            running_accounts
                .into_iter()
                .map(|running| async move { running.client.stop().await }),
        )
        .await;
        self.inner.stopping.store(false, Ordering::Release);
        Ok(())
    }

    async fn refresh_locked(&self) -> Result<(), WeixinServiceError> {
        let accounts = self.inner.dependencies.store.all_accounts().await?;
        let active_ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<HashSet<_>>();

        let orphan_logins = {
            let mut sessions = self.inner.login_sessions.lock().await;
            let orphan_ids = sessions
                .keys()
                .filter(|account_id| !active_ids.contains(*account_id))
                .cloned()
                .collect::<Vec<_>>();
            orphan_ids
                .into_iter()
                .filter_map(|account_id| sessions.remove(&account_id))
                .collect::<Vec<_>>()
        };
        for session in orphan_logins {
            stop_login_session(session).await;
        }

        let running_ids = self
            .inner
            .running_accounts
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for account_id in running_ids {
            if !active_ids.contains(&account_id) {
                self.stop_account(&account_id).await;
            }
        }

        for account in accounts {
            if account.enabled == 0 {
                self.stop_account(&account.id).await;
                continue;
            }
            let Some(ciphertext) = account.bot_token_enc.as_deref() else {
                self.stop_account(&account.id).await;
                continue;
            };
            let Some(base_url) = account.base_url.clone() else {
                self.stop_account(&account.id).await;
                continue;
            };
            let bot_token = match self.inner.dependencies.master_key.decrypt_with_context(
                ciphertext,
                CryptoContext::new("weixin_account")
                    .entity_id(&account.id)
                    .field("bot_token_enc"),
            ) {
                Ok(token) => token,
                Err(error) => {
                    tracing::error!(account_id = account.id, error = %error, "Weixin token decryption failed");
                    continue;
                }
            };
            let credentials = WeixinCredentials {
                account_id: account
                    .weixin_uin
                    .clone()
                    .unwrap_or_else(|| account.id.clone()),
                bot_token: WeixinBotToken::new(bot_token),
                base_url: WeixinBaseUrl::new(base_url),
            };
            let unchanged = self
                .inner
                .running_accounts
                .lock()
                .await
                .get(&account.id)
                .is_some_and(|running| running.credentials == credentials);
            if unchanged {
                continue;
            }
            self.stop_account(&account.id).await;
            self.start_account(account, credentials).await?;
        }
        Ok(())
    }

    async fn start_account(
        &self,
        account: weixin_accounts::Model,
        credentials: WeixinCredentials,
    ) -> Result<(), WeixinServiceError> {
        let context_tokens = self
            .inner
            .dependencies
            .store
            .context_tokens(&account.id)
            .await?;
        let client = Arc::new(WeixinClient::new(
            self.inner.dependencies.transport.clone(),
            Some(credentials.clone()),
        ));
        for token in &context_tokens {
            client.set_context_token(token.user_id.clone(), token.context_token.clone());
        }
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        self.inner.running_accounts.lock().await.insert(
            account.id.clone(),
            RunningAccount {
                credentials,
                client: client.clone(),
                generation,
            },
        );
        self.inner
            .session_expired_notified
            .lock()
            .await
            .remove(&account.id);
        let observer = Arc::new(ServicePollObserver {
            inner: Arc::downgrade(&self.inner),
            account_id: account.id.clone(),
            generation,
        });
        let mut options = WeixinStartOptions::new(observer);
        options.initial_sync_buf = account.sync_buf;
        if let Err(error) = client.start_polling(options).await {
            remove_running_generation(&self.inner, &account.id, generation).await;
            return Err(error.into());
        }
        tracing::info!(
            account_id = account.id,
            account_name = account.name,
            "Weixin account started"
        );
        Ok(())
    }

    async fn stop_account(&self, account_id: &str) {
        let running = self.inner.running_accounts.lock().await.remove(account_id);
        if let Some(running) = running {
            running.client.stop().await;
            tracing::info!(account_id, "Weixin account stopped");
        }
    }

    async fn handle_inbound(&self, account_id: &str, message: WeixinInboundMessage) {
        let account = match self
            .inner
            .dependencies
            .store
            .account_by_id(account_id)
            .await
        {
            Ok(Some(account)) => account,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(account_id, error = %error, "Weixin inbound account lookup failed");
                return;
            }
        };
        if message.from_user_id.is_empty() {
            return;
        }
        let input = UpsertWeixinUserInput {
            account_id: account_id.to_owned(),
            user_id: message.from_user_id.clone(),
            display_name: message.from_user_id,
            context_token: message.context_token,
            allow_auth_requests: account.allow_auth_requests != 0,
            at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if let Err(error) = self
            .inner
            .dependencies
            .store
            .upsert_user_on_inbound(input)
            .await
        {
            tracing::error!(account_id, error = %error, "Weixin inbound user persistence failed");
        }
    }

    async fn handle_session_expired(&self, account_id: &str) {
        let first = self
            .inner
            .session_expired_notified
            .lock()
            .await
            .insert(account_id.to_owned());
        if first {
            tracing::warn!(
                account_id,
                "Weixin account session expired; re-login required"
            );
            match self
                .inner
                .dependencies
                .store
                .authorized_users(account_id)
                .await
            {
                Ok(users) => {
                    for user in users {
                        if let Err(error) = self
                            .inner
                            .dependencies
                            .store
                            .set_user_needs_reactivation(account_id, &user.user_id, true)
                            .await
                        {
                            tracing::error!(account_id, user_id = user.user_id, error = %error, "Weixin reactivation marker failed");
                        }
                    }
                }
                Err(error) => {
                    tracing::error!(account_id, error = %error, "Weixin authorized user lookup failed");
                }
            }
        }
        if let Err(error) = self
            .inner
            .dependencies
            .store
            .update_account(
                account_id,
                WeixinAccountUpdate {
                    weixin_uin: Some(None),
                    bot_token_enc: Some(None),
                    base_url: Some(None),
                    ..WeixinAccountUpdate::default()
                },
            )
            .await
        {
            tracing::error!(account_id, error = %error, "Weixin expired credentials cleanup failed");
        }
    }

    async fn send_to_user(
        &self,
        account_id: &str,
        running: &RunningAccount,
        user: &weixin_account_users::Model,
        text: &str,
    ) -> bool {
        match running.client.send_text(&user.user_id, text, None).await {
            Ok(()) => {
                if user.needs_reactivation != 0 {
                    if let Err(error) = self
                        .inner
                        .dependencies
                        .store
                        .set_user_needs_reactivation(account_id, &user.user_id, false)
                        .await
                    {
                        tracing::error!(account_id, user_id = user.user_id, error = %error, "Weixin reactivation clear failed");
                    }
                }
                true
            }
            Err(WeixinClientError::SessionExpired) => {
                self.handle_session_expired(account_id).await;
                false
            }
            Err(error) => {
                if user.needs_reactivation == 0 {
                    tracing::warn!(account_id, user_id = user.user_id, error = %error, "Weixin send failed; reactivation required");
                }
                if let Err(store_error) = self
                    .inner
                    .dependencies
                    .store
                    .set_user_needs_reactivation(account_id, &user.user_id, true)
                    .await
                {
                    tracing::error!(account_id, user_id = user.user_id, error = %store_error, "Weixin reactivation marker failed");
                }
                true
            }
        }
    }

    async fn ensure_keepalive_task(&self) {
        let mut task = self.inner.keepalive_task.lock().await;
        if task.as_ref().is_some_and(|task| !task.task.is_finished()) {
            return;
        }
        if let Some(finished) = task.take() {
            drop(finished.task);
        }
        let (cancel, mut cancellation) = weixin_cancellation_pair();
        let inner = Arc::downgrade(&self.inner);
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => return,
                    _ = tokio::time::sleep(KEEPALIVE_SWEEP_INTERVAL) => {}
                }
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                WeixinService { inner }.run_keepalive_sweep().await;
            }
        });
        *task = Some(KeepaliveTask {
            cancel,
            task: handle,
        });
    }

    async fn run_keepalive_sweep(&self) {
        let now = Utc::now().timestamp_millis();
        let running = self
            .inner
            .running_accounts
            .lock()
            .await
            .iter()
            .map(|(account_id, running)| (account_id.clone(), running.clone()))
            .collect::<Vec<_>>();
        for (account_id, running) in running {
            let users = match self
                .inner
                .dependencies
                .store
                .authorized_users(&account_id)
                .await
            {
                Ok(users) => users,
                Err(error) => {
                    tracing::error!(account_id, error = %error, "Weixin keepalive user lookup failed");
                    continue;
                }
            };
            for user in users {
                let key = format!("{account_id}:{}", user.user_id);
                let last_inbound = user
                    .last_inbound_at
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map_or(0, |value| value.timestamp_millis());
                let since = {
                    let last = self.inner.last_keepalive_at.lock().await;
                    last_inbound.max(last.get(&key).copied().unwrap_or_default())
                };
                if now.saturating_sub(since) < KEEPALIVE_INTERVAL.as_millis() as i64 {
                    continue;
                }
                self.inner.last_keepalive_at.lock().await.insert(key, now);
                let prompt = self.inner.dependencies.formatter.keepalive_prompt();
                if !self
                    .send_to_user(&account_id, &running, &user, &prompt)
                    .await
                {
                    break;
                }
            }
        }
    }

    async fn persist_login(
        &self,
        account_id: &str,
        credentials: &WeixinCredentials,
    ) -> Result<(), WeixinServiceError> {
        let bot_token_enc = self
            .inner
            .dependencies
            .master_key
            .encrypt(credentials.bot_token.expose_secret())?;
        self.inner
            .dependencies
            .store
            .update_account(
                account_id,
                WeixinAccountUpdate {
                    weixin_uin: Some(Some(credentials.account_id.clone())),
                    bot_token_enc: Some(Some(bot_token_enc)),
                    base_url: Some(Some(credentials.base_url.expose_secret().to_owned())),
                    ..WeixinAccountUpdate::default()
                },
            )
            .await?;
        self.inner
            .session_expired_notified
            .lock()
            .await
            .remove(account_id);
        Ok(())
    }
}

#[async_trait]
impl WeixinServicePort for WeixinService {
    async fn refresh(&self) -> Result<(), WeixinServiceError> {
        WeixinService::refresh(self).await
    }

    async fn send_gateway_online_message(&self, site_name: &str) -> Result<(), WeixinServiceError> {
        WeixinService::send_gateway_online_message(self, site_name).await
    }

    async fn send_to_authorized_users(&self, text: String) -> Result<(), WeixinServiceError> {
        WeixinService::send_to_authorized_users(self, text).await
    }

    async fn send_test_message(
        &self,
        account_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError> {
        WeixinService::send_test_message(self, account_id, user_id, text).await
    }

    async fn send_test_message_to_bound_user(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<(), WeixinServiceError> {
        WeixinService::send_test_message_to_bound_user(self, account_id, text).await
    }

    async fn start_login(
        &self,
        account_id: &str,
    ) -> Result<StartWeixinLoginResponse, WeixinServiceError> {
        WeixinService::start_login(self, account_id).await
    }

    async fn get_login_status(
        &self,
        account_id: &str,
    ) -> Result<WeixinLoginStatusResponse, WeixinServiceError> {
        WeixinService::get_login_status(self, account_id).await
    }

    async fn stop_all(&self) -> Result<(), WeixinServiceError> {
        WeixinService::stop_all(self).await
    }
}

struct ServicePollObserver {
    inner: Weak<WeixinServiceInner>,
    account_id: String,
    generation: u64,
}

#[async_trait]
impl WeixinPollObserver for ServicePollObserver {
    async fn save_sync_buf(&self, value: &str) -> Result<(), WeixinPollCallbackError> {
        let Some(inner) = self.inner.upgrade() else {
            return Err(WeixinPollCallbackError);
        };
        let _lifecycle = inner
            .lifecycle
            .acquire()
            .await
            .map_err(|_| WeixinPollCallbackError)?;
        if !self.is_current(&inner).await {
            return Err(WeixinPollCallbackError);
        }
        inner
            .dependencies
            .store
            .update_account(
                &self.account_id,
                WeixinAccountUpdate {
                    sync_buf: Some(Some(value.to_owned())),
                    ..WeixinAccountUpdate::default()
                },
            )
            .await
            .map_err(|_| WeixinPollCallbackError)?;
        Ok(())
    }

    async fn on_message(
        &self,
        message: WeixinInboundMessage,
    ) -> Result<(), WeixinPollCallbackError> {
        let Some(inner) = self.inner.upgrade() else {
            return Ok(());
        };
        let _lifecycle = inner
            .lifecycle
            .acquire()
            .await
            .map_err(|_| WeixinPollCallbackError)?;
        if self.is_current(&inner).await {
            WeixinService {
                inner: inner.clone(),
            }
            .handle_inbound(&self.account_id, message)
            .await;
        }
        Ok(())
    }

    async fn on_session_expired(&self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let Ok(_lifecycle) = inner.lifecycle.acquire().await else {
            return;
        };
        if self.is_current(&inner).await {
            WeixinService {
                inner: inner.clone(),
            }
            .handle_session_expired(&self.account_id)
            .await;
        }
    }

    async fn on_error(&self, error: &WeixinClientError) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        if !self.is_current(&inner).await {
            return;
        }
        tracing::error!(account_id = self.account_id, error = %error, "Weixin poll error");
    }

    async fn on_stopped(&self) {
        if let Some(inner) = self.inner.upgrade() {
            remove_running_generation(&inner, &self.account_id, self.generation).await;
        }
    }
}

impl ServicePollObserver {
    async fn is_current(&self, inner: &WeixinServiceInner) -> bool {
        inner
            .running_accounts
            .lock()
            .await
            .get(&self.account_id)
            .is_some_and(|running| running.generation == self.generation)
    }
}

async fn remove_running_generation(
    inner: &Arc<WeixinServiceInner>,
    account_id: &str,
    generation: u64,
) {
    let mut running = inner.running_accounts.lock().await;
    if running
        .get(account_id)
        .is_some_and(|running| running.generation == generation)
    {
        running.remove(account_id);
    }
}

async fn stop_login_session(session: LoginSession) {
    session.cancel.cancel();
    session.task.abort();
    let _ = session.task.await;
}

fn set_login_error(state: &StdRwLock<LoginSessionState>, message: &str, expired: bool) {
    let mut state = state
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.status = if expired {
        WeixinLoginStatus::Expired
    } else {
        WeixinLoginStatus::Error
    };
    state.message = Some(message.to_owned());
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::pending;
    use std::sync::atomic::AtomicUsize;

    use tokio::sync::Semaphore;

    use super::*;
    use crate::database::repository::WeixinContextToken;
    use crate::weixin::{
        GetBotQrcodeResponse, GetQrcodeStatusResponse, GetUpdatesRequest, GetUpdatesResponse,
        MessageItem, QrcodeStatus, SendMessageResponse, SendTextRequest, TextItem, WeixinMessage,
        WeixinStoreError, WeixinTransportError, ITEM_TYPE_TEXT, SESSION_EXPIRED_ERRCODE,
    };

    #[derive(Default)]
    struct FakeStoreState {
        accounts: Vec<weixin_accounts::Model>,
        users: Vec<weixin_account_users::Model>,
        reactivation_writes: usize,
    }

    struct FakeStore {
        state: StdMutex<FakeStoreState>,
        credentials_updated: Semaphore,
        credentials_cleared: Semaphore,
        sync_updated: Semaphore,
        reactivation_updated: Semaphore,
        block_next_all_accounts: AtomicBool,
        all_accounts_started: Semaphore,
        all_accounts_release: Semaphore,
    }

    impl FakeStore {
        fn new(account: weixin_accounts::Model) -> Self {
            Self {
                state: StdMutex::new(FakeStoreState {
                    accounts: vec![account],
                    ..FakeStoreState::default()
                }),
                credentials_updated: Semaphore::new(0),
                credentials_cleared: Semaphore::new(0),
                sync_updated: Semaphore::new(0),
                reactivation_updated: Semaphore::new(0),
                block_next_all_accounts: AtomicBool::new(false),
                all_accounts_started: Semaphore::new(0),
                all_accounts_release: Semaphore::new(0),
            }
        }

        fn account(&self) -> Option<weixin_accounts::Model> {
            self.state.lock().expect("store").accounts.first().cloned()
        }

        fn mutate_account(&self, mutate: impl FnOnce(&mut weixin_accounts::Model)) {
            if let Some(account) = self.state.lock().expect("store").accounts.first_mut() {
                mutate(account);
            }
        }

        fn remove_account(&self) {
            self.state.lock().expect("store").accounts.clear();
        }

        fn push_user(&self, user: weixin_account_users::Model) {
            self.state.lock().expect("store").users.push(user);
        }

        fn user(&self, user_id: &str) -> Option<weixin_account_users::Model> {
            self.state
                .lock()
                .expect("store")
                .users
                .iter()
                .find(|user| user.user_id == user_id)
                .cloned()
        }

        fn block_next_all_accounts(&self) {
            self.block_next_all_accounts.store(true, Ordering::Release);
        }
    }

    #[async_trait]
    impl WeixinStore for FakeStore {
        async fn all_accounts(&self) -> Result<Vec<weixin_accounts::Model>, WeixinStoreError> {
            if self.block_next_all_accounts.swap(false, Ordering::AcqRel) {
                self.all_accounts_started.add_permits(1);
                self.all_accounts_release
                    .acquire()
                    .await
                    .expect("release all accounts")
                    .forget();
            }
            Ok(self.state.lock().expect("store").accounts.clone())
        }

        async fn account_by_id(
            &self,
            account_id: &str,
        ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError> {
            Ok(self
                .state
                .lock()
                .expect("store")
                .accounts
                .iter()
                .find(|account| account.id == account_id)
                .cloned())
        }

        async fn update_account(
            &self,
            account_id: &str,
            update: WeixinAccountUpdate,
        ) -> Result<Option<weixin_accounts::Model>, WeixinStoreError> {
            let credential_update = update.bot_token_enc.is_some();
            let credential_clear = update.bot_token_enc == Some(None);
            let sync_update = update.sync_buf.is_some();
            let result = {
                let mut state = self.state.lock().expect("store");
                let Some(account) = state
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == account_id)
                else {
                    return Ok(None);
                };
                if let Some(name) = update.name {
                    account.name = name;
                }
                if let Some(enabled) = update.enabled {
                    account.enabled = i64::from(enabled);
                }
                if let Some(allow) = update.allow_auth_requests {
                    account.allow_auth_requests = i64::from(allow);
                }
                if let Some(value) = update.weixin_uin {
                    account.weixin_uin = value;
                }
                if let Some(value) = update.bot_token_enc {
                    account.bot_token_enc = value;
                }
                if let Some(value) = update.base_url {
                    account.base_url = value;
                }
                if let Some(value) = update.sync_buf {
                    account.sync_buf = value;
                }
                account.clone()
            };
            if credential_update {
                self.credentials_updated.add_permits(1);
            }
            if credential_clear {
                self.credentials_cleared.add_permits(1);
            }
            if sync_update {
                self.sync_updated.add_permits(1);
            }
            Ok(Some(result))
        }

        async fn context_tokens(
            &self,
            account_id: &str,
        ) -> Result<Vec<WeixinContextToken>, WeixinStoreError> {
            Ok(self
                .state
                .lock()
                .expect("store")
                .users
                .iter()
                .filter(|user| user.account_id == account_id)
                .filter_map(|user| {
                    user.last_context_token
                        .clone()
                        .map(|context_token| WeixinContextToken {
                            user_id: user.user_id.clone(),
                            context_token,
                        })
                })
                .collect())
        }

        async fn authorized_users(
            &self,
            account_id: &str,
        ) -> Result<Vec<weixin_account_users::Model>, WeixinStoreError> {
            Ok(self
                .state
                .lock()
                .expect("store")
                .users
                .iter()
                .filter(|user| user.account_id == account_id && user.status == "authorized")
                .cloned()
                .collect())
        }

        async fn upsert_user_on_inbound(
            &self,
            input: UpsertWeixinUserInput,
        ) -> Result<Option<weixin_account_users::Model>, WeixinStoreError> {
            let mut state = self.state.lock().expect("store");
            if let Some(user) = state
                .users
                .iter_mut()
                .find(|user| user.account_id == input.account_id && user.user_id == input.user_id)
            {
                user.display_name = input.display_name;
                if input.context_token.is_some() {
                    user.last_context_token = input.context_token;
                }
                user.last_inbound_at = Some(input.at.clone());
                user.needs_reactivation = 0;
                user.updated_at = input.at;
                return Ok(Some(user.clone()));
            }
            if !input.allow_auth_requests {
                return Ok(None);
            }
            let user = weixin_account_users::Model {
                id: format!("user-{}", state.users.len()),
                account_id: input.account_id,
                user_id: input.user_id,
                display_name: input.display_name,
                status: "pending".to_owned(),
                last_context_token: input.context_token,
                last_inbound_at: Some(input.at.clone()),
                needs_reactivation: 0,
                applied_at: input.at.clone(),
                authorized_at: None,
                updated_at: input.at,
            };
            state.users.push(user.clone());
            Ok(Some(user))
        }

        async fn set_user_needs_reactivation(
            &self,
            account_id: &str,
            user_id: &str,
            value: bool,
        ) -> Result<(), WeixinStoreError> {
            let mut state = self.state.lock().expect("store");
            state.reactivation_writes += 1;
            if let Some(user) = state
                .users
                .iter_mut()
                .find(|user| user.account_id == account_id && user.user_id == user_id)
            {
                user.needs_reactivation = i64::from(value);
            }
            drop(state);
            self.reactivation_updated.add_permits(1);
            Ok(())
        }
    }

    struct PendingPollDrop(Arc<AtomicBool>);

    impl Drop for PendingPollDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    struct FakeTransport {
        qrcodes: StdMutex<VecDeque<GetBotQrcodeResponse>>,
        statuses: StdMutex<VecDeque<GetQrcodeStatusResponse>>,
        updates: StdMutex<VecDeque<GetUpdatesResponse>>,
        update_requests: StdMutex<Vec<GetUpdatesRequest>>,
        sends: StdMutex<Vec<SendTextRequest>>,
        poll_drops: StdMutex<Vec<Arc<AtomicBool>>>,
        poll_started: Semaphore,
        poll_count: AtomicUsize,
    }

    impl Default for FakeTransport {
        fn default() -> Self {
            Self {
                qrcodes: StdMutex::new(VecDeque::new()),
                statuses: StdMutex::new(VecDeque::new()),
                updates: StdMutex::new(VecDeque::new()),
                update_requests: StdMutex::new(Vec::new()),
                sends: StdMutex::new(Vec::new()),
                poll_drops: StdMutex::new(Vec::new()),
                poll_started: Semaphore::new(0),
                poll_count: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl WeixinIlinkTransport for FakeTransport {
        async fn get_bot_qrcode(&self) -> Result<GetBotQrcodeResponse, WeixinTransportError> {
            self.qrcodes
                .lock()
                .expect("qrcodes")
                .pop_front()
                .ok_or(WeixinTransportError::Network)
        }

        async fn get_qrcode_status(
            &self,
            _qrcode: &str,
        ) -> Result<GetQrcodeStatusResponse, WeixinTransportError> {
            self.statuses
                .lock()
                .expect("statuses")
                .pop_front()
                .ok_or(WeixinTransportError::Network)
        }

        async fn get_updates(
            &self,
            request: GetUpdatesRequest,
        ) -> Result<GetUpdatesResponse, WeixinTransportError> {
            self.poll_count.fetch_add(1, Ordering::AcqRel);
            self.update_requests.lock().expect("requests").push(request);
            self.poll_started.add_permits(1);
            let response = self.updates.lock().expect("updates").pop_front();
            if let Some(response) = response {
                return Ok(response);
            }
            let dropped = Arc::new(AtomicBool::new(false));
            self.poll_drops
                .lock()
                .expect("poll drops")
                .push(dropped.clone());
            let _drop = PendingPollDrop(dropped);
            pending().await
        }

        async fn send_message(
            &self,
            request: SendTextRequest,
        ) -> Result<SendMessageResponse, WeixinTransportError> {
            self.sends.lock().expect("sends").push(request);
            Ok(SendMessageResponse::default())
        }
    }

    #[derive(Default)]
    struct TestFormatter;

    impl WeixinMessageFormatter for TestFormatter {
        fn gateway_online(&self, site_name: &str) -> String {
            format!("online {site_name}")
        }

        fn keepalive_prompt(&self) -> String {
            "keepalive".to_owned()
        }

        fn account_not_running(&self) -> String {
            "not running".to_owned()
        }

        fn user_not_found(&self) -> String {
            "not found".to_owned()
        }
    }

    fn account(
        master_key: &MasterKey,
        token: Option<&str>,
        enabled: bool,
    ) -> weixin_accounts::Model {
        weixin_accounts::Model {
            id: "account-1".to_owned(),
            name: "service".to_owned(),
            enabled: i64::from(enabled),
            allow_auth_requests: 1,
            weixin_uin: token.map(|_| "uin-1".to_owned()),
            bot_token_enc: token.map(|token| master_key.encrypt(token).expect("encrypt")),
            base_url: token.map(|_| "https://base-secret.example".to_owned()),
            sync_buf: None,
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    fn authorized_user(context_token: &str) -> weixin_account_users::Model {
        weixin_account_users::Model {
            id: "user-1".to_owned(),
            account_id: "account-1".to_owned(),
            user_id: "user@im.wechat".to_owned(),
            display_name: "user@im.wechat".to_owned(),
            status: "authorized".to_owned(),
            last_context_token: Some(context_token.to_owned()),
            last_inbound_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            needs_reactivation: 0,
            applied_at: "2026-01-01T00:00:00.000Z".to_owned(),
            authorized_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    fn service(
        store: Arc<FakeStore>,
        transport: Arc<FakeTransport>,
        master_key: MasterKey,
    ) -> WeixinService {
        WeixinService::new(WeixinServiceDependencies {
            store,
            master_key,
            transport,
            formatter: Arc::new(TestFormatter),
        })
    }

    async fn wait_for_poll(transport: &FakeTransport) {
        transport
            .poll_started
            .acquire()
            .await
            .expect("poll started")
            .forget();
    }

    #[tokio::test]
    async fn refresh_replaces_credentials_primes_context_and_awaits_every_stopped_poll() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(
            &master_key,
            Some("token-one"),
            true,
        )));
        store.push_user(authorized_user("context-secret"));
        let transport = Arc::new(FakeTransport::default());
        let service = service(store.clone(), transport.clone(), master_key.clone());

        service.refresh().await.expect("first refresh");
        wait_for_poll(&transport).await;
        service
            .send_to_authorized_users("hello".to_owned())
            .await
            .expect("send");
        let (context_token, diagnostic) = {
            let sends = transport.sends.lock().expect("sends");
            (
                sends[0].context_token.clone(),
                format!("{:?} {service:?}", sends[0]),
            )
        };
        assert_eq!(context_token, "context-secret");
        assert!(!diagnostic.contains("token-one"));
        assert!(!diagnostic.contains("base-secret.example"));
        assert!(!diagnostic.contains("context-secret"));

        service.refresh().await.expect("unchanged refresh");
        assert_eq!(transport.poll_count.load(Ordering::Acquire), 1);

        let token_two = master_key.encrypt("token-two").expect("encrypt");
        store.mutate_account(|account| account.bot_token_enc = Some(token_two));
        service.refresh().await.expect("replacement refresh");
        wait_for_poll(&transport).await;
        let drops = transport.poll_drops.lock().expect("drops").clone();
        assert!(drops[0].load(Ordering::Acquire));

        store.mutate_account(|account| account.enabled = 0);
        service.refresh().await.expect("disable refresh");
        assert!(drops[1].load(Ordering::Acquire));

        store.mutate_account(|account| account.enabled = 1);
        service.refresh().await.expect("reenable refresh");
        wait_for_poll(&transport).await;
        let drops = transport.poll_drops.lock().expect("drops").clone();
        store.remove_account();
        service.refresh().await.expect("remove refresh");
        assert!(drops[2].load(Ordering::Acquire));
        service.stop_all().await.expect("stop all");
    }

    #[tokio::test]
    async fn stale_poll_generation_cannot_persist_or_expire_replacement_account() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(
            &master_key,
            Some("token-one"),
            true,
        )));
        let transport = Arc::new(FakeTransport::default());
        let service = service(store.clone(), transport.clone(), master_key.clone());

        service.refresh().await.expect("first refresh");
        wait_for_poll(&transport).await;
        let stale_generation = service
            .inner
            .running_accounts
            .lock()
            .await
            .get("account-1")
            .expect("running account")
            .generation;

        store.mutate_account(|account| {
            account.bot_token_enc = Some(master_key.encrypt("token-two").expect("encrypt"));
        });
        service.refresh().await.expect("replacement refresh");
        wait_for_poll(&transport).await;

        let stale = ServicePollObserver {
            inner: Arc::downgrade(&service.inner),
            account_id: "account-1".to_owned(),
            generation: stale_generation,
        };
        let save_result = stale.save_sync_buf("stale-sync").await;
        stale
            .on_message(WeixinInboundMessage {
                from_user_id: "stale@im.wechat".to_owned(),
                context_token: Some("stale-context".to_owned()),
                text: "stale".to_owned(),
                raw: WeixinMessage::default(),
            })
            .await
            .expect("stale message is ignored");
        stale.on_session_expired().await;
        stale.on_error(&WeixinClientError::Callback).await;

        assert_eq!(save_result, Err(WeixinPollCallbackError));
        let account = store.account().expect("replacement account");
        assert!(account.sync_buf.is_none());
        assert_eq!(
            master_key
                .decrypt(account.bot_token_enc.as_deref().expect("replacement token"))
                .expect("decrypt"),
            "token-two"
        );
        assert!(store.user("stale@im.wechat").is_none());
        assert_eq!(store.state.lock().expect("store").reactivation_writes, 0);
        service.stop_all().await.expect("stop all");
    }

    #[tokio::test]
    async fn refresh_fences_an_in_flight_old_generation_before_its_side_effect() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(
            &master_key,
            Some("token-one"),
            true,
        )));
        let transport = Arc::new(FakeTransport::default());
        let service = service(store.clone(), transport.clone(), master_key.clone());

        service.refresh().await.expect("first refresh");
        wait_for_poll(&transport).await;
        let stale_generation = service
            .inner
            .running_accounts
            .lock()
            .await
            .get("account-1")
            .expect("running account")
            .generation;
        let stale = ServicePollObserver {
            inner: Arc::downgrade(&service.inner),
            account_id: "account-1".to_owned(),
            generation: stale_generation,
        };

        store.mutate_account(|account| {
            account.bot_token_enc = Some(master_key.encrypt("token-two").expect("encrypt"));
        });
        store.block_next_all_accounts();
        let refresh = tokio::spawn({
            let service = service.clone();
            async move { service.refresh().await }
        });
        store
            .all_accounts_started
            .acquire()
            .await
            .expect("refresh reached store")
            .forget();
        let stale_callback = tokio::spawn(async move { stale.save_sync_buf("stale-sync").await });
        tokio::task::yield_now().await;
        assert!(!stale_callback.is_finished());

        store.all_accounts_release.add_permits(1);
        refresh.await.expect("refresh task").expect("refresh");
        wait_for_poll(&transport).await;
        assert_eq!(
            stale_callback.await.expect("stale callback task"),
            Err(WeixinPollCallbackError)
        );
        let account = store.account().expect("replacement account");
        assert!(account.sync_buf.is_none());
        assert_eq!(
            master_key
                .decrypt(account.bot_token_enc.as_deref().expect("replacement token"))
                .expect("decrypt"),
            "token-two"
        );
        service.stop_all().await.expect("stop all");
    }

    #[tokio::test]
    async fn session_expiry_persists_sync_clears_credentials_and_marks_users_only_once() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(
            &master_key,
            Some("token-one"),
            true,
        )));
        store.push_user(authorized_user("old-context"));
        let transport = Arc::new(FakeTransport::default());
        transport.updates.lock().expect("updates").extend([
            GetUpdatesResponse {
                ret: Some(0),
                msgs: Some(vec![WeixinMessage {
                    from_user_id: Some("user@im.wechat".to_owned()),
                    context_token: Some("new-context".to_owned()),
                    item_list: Some(vec![MessageItem {
                        r#type: Some(ITEM_TYPE_TEXT),
                        text_item: Some(TextItem {
                            text: Some("hello".to_owned()),
                        }),
                        ..MessageItem::default()
                    }]),
                    ..WeixinMessage::default()
                }]),
                get_updates_buf: Some("sync-next".to_owned()),
                ..GetUpdatesResponse::default()
            },
            GetUpdatesResponse {
                ret: Some(SESSION_EXPIRED_ERRCODE),
                ..GetUpdatesResponse::default()
            },
        ]);
        let service = service(store.clone(), transport, master_key);
        service.refresh().await.expect("refresh");
        store
            .credentials_cleared
            .acquire()
            .await
            .expect("credentials cleared")
            .forget();

        let account = store.account().expect("account");
        assert_eq!(account.sync_buf.as_deref(), Some("sync-next"));
        assert!(account.bot_token_enc.is_none());
        assert!(account.base_url.is_none());
        assert!(account.weixin_uin.is_none());
        let user = store.user("user@im.wechat").expect("user");
        assert_eq!(user.last_context_token.as_deref(), Some("new-context"));
        assert_eq!(user.needs_reactivation, 1);

        service.handle_session_expired("account-1").await;
        assert_eq!(store.state.lock().expect("store").reactivation_writes, 1);
        store.mutate_account(|account| account.allow_auth_requests = 0);
        service
            .handle_inbound(
                "account-1",
                WeixinInboundMessage {
                    from_user_id: "blocked@im.wechat".to_owned(),
                    context_token: Some("blocked-context".to_owned()),
                    text: "hello".to_owned(),
                    raw: WeixinMessage::default(),
                },
            )
            .await;
        assert!(store.user("blocked@im.wechat").is_none());
        service.stop_all().await.expect("stop all");
    }

    #[tokio::test]
    async fn login_persists_legacy_ciphertext_then_starts_a_cancellable_account() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(&master_key, None, true)));
        let transport = Arc::new(FakeTransport::default());
        transport
            .qrcodes
            .lock()
            .expect("qrcodes")
            .push_back(GetBotQrcodeResponse {
                qrcode: Some("qr-id".to_owned()),
                qrcode_img_content: Some("qr-url".to_owned()),
                ..GetBotQrcodeResponse::default()
            });
        transport
            .statuses
            .lock()
            .expect("statuses")
            .push_back(GetQrcodeStatusResponse {
                status: Some(QrcodeStatus::Confirmed),
                bot_token: Some("login-token-secret".to_owned()),
                baseurl: Some("https://login-base-secret.example".to_owned()),
                ilink_bot_id: Some("weixin-uin".to_owned()),
                ..GetQrcodeStatusResponse::default()
            });
        let service = service(store.clone(), transport.clone(), master_key.clone());
        let response = service.start_login("account-1").await.expect("start login");
        assert_eq!(response.qrcode_url, "qr-url");
        store
            .credentials_updated
            .acquire()
            .await
            .expect("credentials updated")
            .forget();
        wait_for_poll(&transport).await;

        let account = store.account().expect("account");
        let ciphertext = account.bot_token_enc.expect("ciphertext");
        assert_ne!(ciphertext, "login-token-secret");
        assert_eq!(
            master_key
                .decrypt(&ciphertext)
                .expect("decrypt persisted token"),
            "login-token-secret"
        );
        assert_eq!(account.weixin_uin.as_deref(), Some("weixin-uin"));
        let status = service
            .get_login_status("account-1")
            .await
            .expect("login status");
        assert_eq!(status.status, WeixinLoginStatus::Confirmed);
        assert!(status.logged_in);
        let drops = transport.poll_drops.lock().expect("drops").clone();
        service.stop_all().await.expect("stop all");
        assert!(drops[0].load(Ordering::Acquire));
        assert!(!format!("{status:?}").contains("login-token-secret"));
    }

    #[tokio::test]
    async fn login_waiting_behind_stop_all_cannot_start_after_shutdown_drain() {
        let master_key = MasterKey::development_default();
        let store = Arc::new(FakeStore::new(account(&master_key, None, true)));
        let transport = Arc::new(FakeTransport::default());
        transport
            .qrcodes
            .lock()
            .expect("qrcodes")
            .push_back(GetBotQrcodeResponse {
                qrcode: Some("late-qr-id".to_owned()),
                qrcode_img_content: Some("late-qr-url".to_owned()),
                ..GetBotQrcodeResponse::default()
            });
        let service = service(store, transport.clone(), master_key);
        let lifecycle = service
            .inner
            .lifecycle
            .acquire()
            .await
            .expect("hold lifecycle");

        let start = tokio::spawn({
            let service = service.clone();
            async move { service.start_login("account-1").await }
        });
        tokio::task::yield_now().await;
        let stop = tokio::spawn({
            let service = service.clone();
            async move { service.stop_all().await }
        });
        while !service.inner.stopping.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        drop(lifecycle);

        let start_result = start.await.expect("start task");
        stop.await.expect("stop task").expect("stop all");
        assert!(matches!(
            start_result,
            Err(WeixinServiceError::ServiceStopping)
        ));
        assert!(service.inner.login_sessions.lock().await.is_empty());
        assert_eq!(transport.qrcodes.lock().expect("qrcodes").len(), 1);
    }
}
