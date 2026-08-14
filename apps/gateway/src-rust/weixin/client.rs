use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use rand::rngs::OsRng;
use rand::RngCore;
use tokio::sync::watch;
use tokio::time::Instant;

use super::{
    redact_known_secrets, GetUpdatesRequest, GetUpdatesResponse, QrcodeStatus, SendTextRequest,
    WeixinClientError, WeixinCredentials, WeixinIlinkTransport, WeixinInboundMessage,
    WeixinMessage, WeixinQrcode, CLIENT_ID_PREFIX, DEFAULT_LOGIN_TIMEOUT, DEFAULT_LONGPOLL_TIMEOUT,
    DEFAULT_QRCODE_POLL_INTERVAL, INITIAL_RETRY_DELAY, ITEM_TYPE_TEXT, LONGPOLL_TIMEOUT_MARGIN,
    MAX_QRCODE_REFRESHES, MAX_RETRY_DELAY, SESSION_EXPIRED_ERRCODE,
};

#[derive(Clone)]
pub struct WeixinCancelHandle {
    sender: watch::Sender<bool>,
}

impl fmt::Debug for WeixinCancelHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WeixinCancelHandle")
    }
}

impl WeixinCancelHandle {
    pub fn cancel(&self) {
        let _ = self.sender.send(true);
    }
}

#[derive(Clone)]
pub struct WeixinCancellation {
    receiver: watch::Receiver<bool>,
}

impl fmt::Debug for WeixinCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WeixinCancellation")
    }
}

impl WeixinCancellation {
    pub fn is_cancelled(&self) -> bool {
        *self.receiver.borrow()
    }

    pub(crate) async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        let _ = self.receiver.changed().await;
    }
}

pub fn weixin_cancellation_pair() -> (WeixinCancelHandle, WeixinCancellation) {
    let (sender, receiver) = watch::channel(false);
    (
        WeixinCancelHandle { sender },
        WeixinCancellation { receiver },
    )
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Weixin poll callback failed")]
pub struct WeixinPollCallbackError;

#[async_trait]
pub trait WeixinPollObserver: Send + Sync {
    async fn save_sync_buf(&self, value: &str) -> Result<(), WeixinPollCallbackError>;
    async fn on_message(
        &self,
        message: WeixinInboundMessage,
    ) -> Result<(), WeixinPollCallbackError>;
    async fn on_session_expired(&self);
    async fn on_error(&self, error: &WeixinClientError);
    async fn on_stopped(&self);
}

pub struct WeixinLoginOptions {
    pub on_qrcode: Arc<dyn Fn(WeixinQrcode) + Send + Sync>,
    pub cancellation: WeixinCancellation,
    pub timeout: Duration,
    pub poll_interval: Duration,
}

impl WeixinLoginOptions {
    pub fn new(
        on_qrcode: Arc<dyn Fn(WeixinQrcode) + Send + Sync>,
        cancellation: WeixinCancellation,
    ) -> Self {
        Self {
            on_qrcode,
            cancellation,
            timeout: DEFAULT_LOGIN_TIMEOUT,
            poll_interval: DEFAULT_QRCODE_POLL_INTERVAL,
        }
    }
}

pub struct WeixinStartOptions {
    pub initial_sync_buf: Option<String>,
    pub initial_context_tokens: HashMap<String, String>,
    pub observer: Arc<dyn WeixinPollObserver>,
    pub initial_longpoll_timeout: Duration,
}

impl WeixinStartOptions {
    pub fn new(observer: Arc<dyn WeixinPollObserver>) -> Self {
        Self {
            initial_sync_buf: None,
            initial_context_tokens: HashMap::new(),
            observer,
            initial_longpoll_timeout: DEFAULT_LONGPOLL_TIMEOUT,
        }
    }
}

pub struct WeixinClient {
    transport: Arc<dyn WeixinIlinkTransport>,
    credentials: RwLock<Option<WeixinCredentials>>,
    context_tokens: RwLock<HashMap<String, String>>,
    poll_state: Mutex<PollState>,
    running: AtomicBool,
}

enum PollState {
    Idle,
    Running(PollTask),
    Stopping(watch::Receiver<bool>),
}

struct PollTask {
    cancel: WeixinCancelHandle,
    handle: tokio::task::JoinHandle<()>,
}

impl fmt::Debug for WeixinClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WeixinClient")
            .field("credentials", &self.credentials())
            .field("running", &self.is_running())
            .finish()
    }
}

impl WeixinClient {
    pub fn new(
        transport: Arc<dyn WeixinIlinkTransport>,
        credentials: Option<WeixinCredentials>,
    ) -> Self {
        let credentials = credentials.filter(|credentials| {
            !credentials.account_id.is_empty()
                && !credentials.bot_token.expose_secret().is_empty()
                && !credentials.base_url.expose_secret().is_empty()
        });
        Self {
            transport,
            credentials: RwLock::new(credentials),
            context_tokens: RwLock::new(HashMap::new()),
            poll_state: Mutex::new(PollState::Idle),
            running: AtomicBool::new(false),
        }
    }

    pub fn credentials(&self) -> Option<WeixinCredentials> {
        self.credentials
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn get_context_token(&self, user_id: &str) -> Option<String> {
        self.context_tokens
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(user_id)
            .cloned()
    }

    pub fn set_context_token(&self, user_id: impl Into<String>, token: impl Into<String>) {
        self.context_tokens
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(user_id.into(), token.into());
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn extract_text(message: &WeixinMessage) -> String {
        message
            .item_list
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|item| {
                (item.r#type == Some(ITEM_TYPE_TEXT))
                    .then(|| item.text_item.as_ref()?.text.as_deref())
                    .flatten()
            })
            .collect::<String>()
    }

    pub async fn login(
        &self,
        mut options: WeixinLoginOptions,
    ) -> Result<WeixinCredentials, WeixinClientError> {
        let timeout = options.timeout.max(Duration::from_secs(1));
        let deadline = Instant::now() + timeout;
        let mut qrcode_id = self
            .fetch_qrcode(&options.on_qrcode, deadline, &mut options.cancellation)
            .await?;
        let mut refreshes = 0;

        loop {
            self.before_login_deadline(
                deadline,
                &mut options.cancellation,
                tokio::time::sleep(options.poll_interval),
            )
            .await?;
            let status = match self
                .before_login_deadline(
                    deadline,
                    &mut options.cancellation,
                    self.transport.get_qrcode_status(&qrcode_id),
                )
                .await
            {
                Ok(Ok(status)) => status,
                Ok(Err(_)) => continue,
                Err(error) => return Err(error),
            };

            match status.status {
                Some(QrcodeStatus::Confirmed) => {
                    let bot_token = status
                        .bot_token
                        .filter(|value| !value.is_empty())
                        .ok_or(WeixinClientError::MissingConfirmedCredentials)?;
                    let base_url = status
                        .baseurl
                        .filter(|value| !value.is_empty())
                        .ok_or(WeixinClientError::MissingConfirmedCredentials)?;
                    let account_id = status
                        .ilink_bot_id
                        .or(status.ilink_user_id)
                        .unwrap_or_else(|| bot_token.clone());
                    let credentials = WeixinCredentials {
                        account_id,
                        bot_token: super::WeixinBotToken::new(bot_token),
                        base_url: super::WeixinBaseUrl::new(base_url),
                    };
                    *self
                        .credentials
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(credentials.clone());
                    return Ok(credentials);
                }
                Some(QrcodeStatus::Expired) => {
                    if refreshes >= MAX_QRCODE_REFRESHES {
                        return Err(WeixinClientError::QrcodeRefreshLimit);
                    }
                    refreshes += 1;
                    qrcode_id = self
                        .fetch_qrcode(&options.on_qrcode, deadline, &mut options.cancellation)
                        .await?;
                }
                _ => {}
            }
        }
    }

    pub async fn start_polling(
        self: &Arc<Self>,
        options: WeixinStartOptions,
    ) -> Result<(), WeixinClientError> {
        if self.credentials().is_none() {
            return Err(WeixinClientError::MissingCredentials);
        }
        for (user_id, token) in &options.initial_context_tokens {
            self.set_context_token(user_id.clone(), token.clone());
        }

        let mut state = self
            .poll_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let PollState::Running(task) = &*state {
            if !task.handle.is_finished() {
                return Err(WeixinClientError::AlreadyRunning);
            }
        }
        if matches!(&*state, PollState::Stopping(_)) {
            return Err(WeixinClientError::AlreadyRunning);
        }
        if let PollState::Running(task) = std::mem::replace(&mut *state, PollState::Idle) {
            drop(task.handle);
        }

        let (cancel, cancellation) = weixin_cancellation_pair();
        let client = Arc::clone(self);
        let observer = options.observer.clone();
        self.running.store(true, Ordering::Release);
        let handle = tokio::spawn(async move {
            let result = client.poll_loop(options, cancellation).await;
            client.running.store(false, Ordering::Release);
            if let Err(error) = &result {
                if !matches!(
                    error,
                    WeixinClientError::Cancelled | WeixinClientError::SessionExpired
                ) {
                    observer.on_error(error).await;
                }
            }
            observer.on_stopped().await;
        });
        *state = PollState::Running(PollTask { cancel, handle });
        Ok(())
    }

    pub async fn stop(self: &Arc<Self>) {
        let mut receiver = {
            let mut state = self
                .poll_state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match std::mem::replace(&mut *state, PollState::Idle) {
                PollState::Idle => return,
                PollState::Running(task) => {
                    task.cancel.cancel();
                    task.handle.abort();
                    let (done, receiver) = watch::channel(false);
                    *state = PollState::Stopping(receiver.clone());
                    let client = Arc::clone(self);
                    tokio::spawn(async move {
                        let _ = task.handle.await;
                        client.running.store(false, Ordering::Release);
                        let mut state = client
                            .poll_state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let _ = done.send(true);
                        *state = PollState::Idle;
                    });
                    receiver
                }
                PollState::Stopping(receiver) => {
                    *state = PollState::Stopping(receiver.clone());
                    receiver
                }
            }
        };
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }

    pub async fn send_text(
        &self,
        to_user_id: &str,
        text: &str,
        context_token: Option<&str>,
    ) -> Result<(), WeixinClientError> {
        let credentials = self
            .credentials()
            .ok_or(WeixinClientError::MissingCredentials)?;
        let context_token = context_token
            .map(str::to_owned)
            .or_else(|| self.get_context_token(to_user_id))
            .filter(|token| !token.is_empty())
            .ok_or_else(|| WeixinClientError::NoContextToken {
                user_id: to_user_id.to_owned(),
            })?;
        let context_secret = context_token.clone();
        let response = self
            .transport
            .send_message(SendTextRequest {
                credentials: credentials.clone(),
                to_user_id: to_user_id.to_owned(),
                context_token,
                client_id: generate_client_id(),
                items: vec![text.to_owned()],
            })
            .await?;
        if response.ret == Some(SESSION_EXPIRED_ERRCODE)
            || response.errcode == Some(SESSION_EXPIRED_ERRCODE)
        {
            return Err(WeixinClientError::SessionExpired);
        }
        if let Some(ret) = response.ret.filter(|ret| *ret != 0) {
            return Err(WeixinClientError::Business {
                endpoint: "sendmessage",
                ret,
                message: redact_known_secrets(
                    &sanitize_business_message(response.errmsg.as_deref(), &credentials),
                    &[&context_secret],
                ),
            });
        }
        Ok(())
    }

    async fn fetch_qrcode(
        &self,
        on_qrcode: &Arc<dyn Fn(WeixinQrcode) + Send + Sync>,
        deadline: Instant,
        cancellation: &mut WeixinCancellation,
    ) -> Result<String, WeixinClientError> {
        let response = self
            .before_login_deadline(deadline, cancellation, self.transport.get_bot_qrcode())
            .await??;
        let qrcode_id = response
            .qrcode
            .filter(|value| !value.is_empty())
            .ok_or(WeixinClientError::MissingQrcode)?;
        let url = response
            .qrcode_img_content
            .filter(|value| !value.is_empty())
            .ok_or(WeixinClientError::MissingQrcodeContent)?;
        on_qrcode(WeixinQrcode {
            url,
            qrcode_id: qrcode_id.clone(),
        });
        Ok(qrcode_id)
    }

    async fn before_login_deadline<T, F>(
        &self,
        deadline: Instant,
        cancellation: &mut WeixinCancellation,
        future: F,
    ) -> Result<T, WeixinClientError>
    where
        F: Future<Output = T>,
    {
        tokio::select! {
            _ = cancellation.cancelled() => Err(WeixinClientError::Cancelled),
            result = tokio::time::timeout_at(deadline, future) => {
                result.map_err(|_| WeixinClientError::LoginTimedOut)
            }
        }
    }

    async fn poll_loop(
        &self,
        options: WeixinStartOptions,
        mut cancellation: WeixinCancellation,
    ) -> Result<(), WeixinClientError> {
        let credentials = self
            .credentials()
            .ok_or(WeixinClientError::MissingCredentials)?;
        let mut get_updates_buf = options.initial_sync_buf.unwrap_or_default();
        let mut failures = 0_u32;
        let mut longpoll_timeout = options.initial_longpoll_timeout;

        while !cancellation.is_cancelled() {
            let request = GetUpdatesRequest {
                credentials: credentials.clone(),
                get_updates_buf: get_updates_buf.clone(),
            };
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(WeixinClientError::Cancelled),
                result = tokio::time::timeout(longpoll_timeout, self.transport.get_updates(request)) => result,
            };
            let response = match response {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    let error = WeixinClientError::Transport(error);
                    options.observer.on_error(&error).await;
                    failures = failures.saturating_add(1);
                    cancel_aware_sleep(retry_delay(failures), &mut cancellation).await?;
                    continue;
                }
                Err(_) => {
                    let error = WeixinClientError::Transport(super::WeixinTransportError::Network);
                    options.observer.on_error(&error).await;
                    failures = failures.saturating_add(1);
                    cancel_aware_sleep(retry_delay(failures), &mut cancellation).await?;
                    continue;
                }
            };

            if is_session_expired(&response) {
                options.observer.on_session_expired().await;
                return Err(WeixinClientError::SessionExpired);
            }
            if let Some(ret) = response.ret.filter(|ret| *ret != 0) {
                let error = WeixinClientError::Business {
                    endpoint: "getupdates",
                    ret,
                    message: sanitize_business_message(response.errmsg.as_deref(), &credentials),
                };
                options.observer.on_error(&error).await;
                failures = failures.saturating_add(1);
                cancel_aware_sleep(retry_delay(failures), &mut cancellation).await?;
                continue;
            }

            failures = 0;
            if let Some(timeout_ms) = response
                .longpolling_timeout_ms
                .filter(|timeout_ms| *timeout_ms > 0)
            {
                longpoll_timeout = Duration::from_millis(timeout_ms as u64)
                    .saturating_add(LONGPOLL_TIMEOUT_MARGIN);
            }

            for message in response.msgs.unwrap_or_default() {
                if cancellation.is_cancelled() {
                    break;
                }
                let inbound = Self::to_inbound(message.clone());
                if let (Some(user_id), Some(context_token)) =
                    (message.from_user_id, message.context_token)
                {
                    if !user_id.is_empty() && !context_token.is_empty() {
                        self.set_context_token(user_id, context_token);
                    }
                }
                if options.observer.on_message(inbound).await.is_err() {
                    options
                        .observer
                        .on_error(&WeixinClientError::Callback)
                        .await;
                }
            }

            if let Some(next) = response
                .get_updates_buf
                .filter(|get_updates_buf| !get_updates_buf.is_empty())
            {
                get_updates_buf = next;
                options
                    .observer
                    .save_sync_buf(&get_updates_buf)
                    .await
                    .map_err(|_| WeixinClientError::Callback)?;
            }
        }
        Err(WeixinClientError::Cancelled)
    }

    fn to_inbound(message: WeixinMessage) -> WeixinInboundMessage {
        WeixinInboundMessage {
            from_user_id: message.from_user_id.clone().unwrap_or_default(),
            context_token: message.context_token.clone(),
            text: Self::extract_text(&message),
            raw: message,
        }
    }
}

fn is_session_expired(response: &GetUpdatesResponse) -> bool {
    response.ret == Some(SESSION_EXPIRED_ERRCODE)
        || response.errcode == Some(SESSION_EXPIRED_ERRCODE)
}

fn sanitize_business_message(message: Option<&str>, credentials: &WeixinCredentials) -> String {
    redact_known_secrets(
        message.unwrap_or_default(),
        &[
            credentials.bot_token.expose_secret(),
            credentials.base_url.expose_secret(),
        ],
    )
}

fn retry_delay(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(30);
    INITIAL_RETRY_DELAY
        .saturating_mul(1_u32 << exponent)
        .min(MAX_RETRY_DELAY)
}

async fn cancel_aware_sleep(
    duration: Duration,
    cancellation: &mut WeixinCancellation,
) -> Result<(), WeixinClientError> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(WeixinClientError::Cancelled),
        _ = tokio::time::sleep(duration) => Ok(()),
    }
}

fn generate_client_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(CLIENT_ID_PREFIX.len() + bytes.len() * 2);
    value.push_str(CLIENT_ID_PREFIX);
    for byte in bytes {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        value.push(char::from(HEX[usize::from(byte >> 4)]));
        value.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    value
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::{pending, Future};
    use std::sync::atomic::AtomicUsize;
    use std::task::Poll;

    use tokio::sync::{Notify, Semaphore};

    use super::*;
    use crate::weixin::{
        GetBotQrcodeResponse, GetQrcodeStatusResponse, MessageItem, QrcodeStatus,
        SendMessageResponse, TextItem, WeixinBaseUrl, WeixinBotToken, WeixinTransportError,
    };

    enum StatusPlan {
        Response(GetQrcodeStatusResponse),
        Pending(Arc<AtomicBool>),
    }

    struct PendingDrop(Arc<AtomicBool>);

    impl Drop for PendingDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    struct FakeTransport {
        qrcodes: Mutex<VecDeque<GetBotQrcodeResponse>>,
        statuses: Mutex<VecDeque<StatusPlan>>,
        updates: Mutex<VecDeque<GetUpdatesResponse>>,
        update_requests: Mutex<Vec<GetUpdatesRequest>>,
        sends: Mutex<Vec<SendTextRequest>>,
        status_started: Semaphore,
    }

    impl Default for FakeTransport {
        fn default() -> Self {
            Self {
                qrcodes: Mutex::new(VecDeque::new()),
                statuses: Mutex::new(VecDeque::new()),
                updates: Mutex::new(VecDeque::new()),
                update_requests: Mutex::new(Vec::new()),
                sends: Mutex::new(Vec::new()),
                status_started: Semaphore::new(0),
            }
        }
    }

    #[async_trait]
    impl WeixinIlinkTransport for FakeTransport {
        async fn get_bot_qrcode(&self) -> Result<GetBotQrcodeResponse, WeixinTransportError> {
            self.qrcodes
                .lock()
                .expect("qrcode plans")
                .pop_front()
                .ok_or(WeixinTransportError::Network)
        }

        async fn get_qrcode_status(
            &self,
            _qrcode: &str,
        ) -> Result<GetQrcodeStatusResponse, WeixinTransportError> {
            self.status_started.add_permits(1);
            let plan = self
                .statuses
                .lock()
                .expect("status plans")
                .pop_front()
                .ok_or(WeixinTransportError::Network)?;
            match plan {
                StatusPlan::Response(response) => Ok(response),
                StatusPlan::Pending(dropped) => {
                    let _drop = PendingDrop(dropped);
                    pending().await
                }
            }
        }

        async fn get_updates(
            &self,
            request: GetUpdatesRequest,
        ) -> Result<GetUpdatesResponse, WeixinTransportError> {
            self.update_requests
                .lock()
                .expect("update requests")
                .push(request);
            let response = self.updates.lock().expect("update plans").pop_front();
            if let Some(response) = response {
                Ok(response)
            } else {
                pending().await
            }
        }

        async fn send_message(
            &self,
            request: SendTextRequest,
        ) -> Result<SendMessageResponse, WeixinTransportError> {
            self.sends.lock().expect("sends").push(request);
            Ok(SendMessageResponse::default())
        }
    }

    fn credentials() -> WeixinCredentials {
        WeixinCredentials {
            account_id: "account-1".to_owned(),
            bot_token: WeixinBotToken::new("token-secret"),
            base_url: WeixinBaseUrl::new("https://base-secret.example"),
        }
    }

    #[derive(Default)]
    struct RecordingObserver {
        sync_bufs: Mutex<Vec<String>>,
        messages: Mutex<Vec<WeixinInboundMessage>>,
        expired: AtomicUsize,
        errors: Mutex<Vec<String>>,
        stopped: Notify,
    }

    #[async_trait]
    impl WeixinPollObserver for RecordingObserver {
        async fn save_sync_buf(&self, value: &str) -> Result<(), WeixinPollCallbackError> {
            self.sync_bufs
                .lock()
                .expect("sync buffers")
                .push(value.to_owned());
            Ok(())
        }

        async fn on_message(
            &self,
            message: WeixinInboundMessage,
        ) -> Result<(), WeixinPollCallbackError> {
            self.messages.lock().expect("messages").push(message);
            Ok(())
        }

        async fn on_session_expired(&self) {
            self.expired.fetch_add(1, Ordering::AcqRel);
        }

        async fn on_error(&self, error: &WeixinClientError) {
            self.errors.lock().expect("errors").push(error.to_string());
        }

        async fn on_stopped(&self) {
            self.stopped.notify_waiters();
        }
    }

    fn text_message() -> WeixinMessage {
        WeixinMessage {
            from_user_id: Some("alice@im.wechat".to_owned()),
            context_token: Some("context-alice".to_owned()),
            item_list: Some(vec![
                MessageItem {
                    r#type: Some(ITEM_TYPE_TEXT),
                    text_item: Some(TextItem {
                        text: Some("a".to_owned()),
                    }),
                    ..MessageItem::default()
                },
                MessageItem {
                    r#type: Some(super::super::ITEM_TYPE_IMAGE),
                    ..MessageItem::default()
                },
                MessageItem {
                    r#type: Some(ITEM_TYPE_TEXT),
                    text_item: Some(TextItem {
                        text: Some("b".to_owned()),
                    }),
                    ..MessageItem::default()
                },
            ]),
            ..WeixinMessage::default()
        }
    }

    #[tokio::test]
    async fn login_refresh_limit_and_cancellation_are_total_and_drop_pending_requests() {
        let refresh_transport = Arc::new(FakeTransport::default());
        for index in 0..=MAX_QRCODE_REFRESHES {
            refresh_transport
                .qrcodes
                .lock()
                .expect("qrcodes")
                .push_back(GetBotQrcodeResponse {
                    qrcode: Some(format!("qr-{index}")),
                    qrcode_img_content: Some(format!("url-{index}")),
                    ..GetBotQrcodeResponse::default()
                });
            refresh_transport
                .statuses
                .lock()
                .expect("statuses")
                .push_back(StatusPlan::Response(GetQrcodeStatusResponse {
                    status: Some(QrcodeStatus::Expired),
                    ..GetQrcodeStatusResponse::default()
                }));
        }
        let client = WeixinClient::new(refresh_transport.clone(), None);
        let (_cancel, cancellation) = weixin_cancellation_pair();
        let mut options = WeixinLoginOptions::new(Arc::new(|_| {}), cancellation);
        options.poll_interval = Duration::ZERO;
        options.timeout = Duration::from_secs(5);
        assert_eq!(
            client.login(options).await,
            Err(WeixinClientError::QrcodeRefreshLimit)
        );
        assert!(refresh_transport
            .qrcodes
            .lock()
            .expect("qrcodes")
            .is_empty());

        let cancel_transport = Arc::new(FakeTransport::default());
        cancel_transport
            .qrcodes
            .lock()
            .expect("qrcodes")
            .push_back(GetBotQrcodeResponse {
                qrcode: Some("qr".to_owned()),
                qrcode_img_content: Some("url".to_owned()),
                ..GetBotQrcodeResponse::default()
            });
        let pending_dropped = Arc::new(AtomicBool::new(false));
        cancel_transport
            .statuses
            .lock()
            .expect("statuses")
            .push_back(StatusPlan::Pending(pending_dropped.clone()));
        let client = Arc::new(WeixinClient::new(cancel_transport.clone(), None));
        let (cancel, cancellation) = weixin_cancellation_pair();
        let mut options = WeixinLoginOptions::new(Arc::new(|_| {}), cancellation);
        options.poll_interval = Duration::ZERO;
        let login = tokio::spawn({
            let client = client.clone();
            async move { client.login(options).await }
        });
        cancel_transport
            .status_started
            .acquire()
            .await
            .expect("status started")
            .forget();
        cancel.cancel();
        assert_eq!(
            login.await.expect("login task"),
            Err(WeixinClientError::Cancelled)
        );
        assert!(pending_dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn polling_advances_only_nonempty_sync_caches_context_and_stops_on_minus_fourteen() {
        let transport = Arc::new(FakeTransport::default());
        transport.updates.lock().expect("updates").extend([
            GetUpdatesResponse {
                ret: Some(0),
                msgs: Some(vec![text_message()]),
                get_updates_buf: Some("cursor-2".to_owned()),
                longpolling_timeout_ms: Some(35_000),
                ..GetUpdatesResponse::default()
            },
            GetUpdatesResponse {
                ret: Some(0),
                get_updates_buf: Some(String::new()),
                ..GetUpdatesResponse::default()
            },
            GetUpdatesResponse {
                errcode: Some(SESSION_EXPIRED_ERRCODE),
                ..GetUpdatesResponse::default()
            },
        ]);
        let observer = Arc::new(RecordingObserver::default());
        let client = Arc::new(WeixinClient::new(transport.clone(), Some(credentials())));
        let stopped = observer.stopped.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        client
            .start_polling(WeixinStartOptions::new(observer.clone()))
            .await
            .expect("start polling");
        stopped.await;

        assert_eq!(
            observer.sync_bufs.lock().expect("sync buffers").as_slice(),
            &["cursor-2"]
        );
        let message_texts = observer
            .messages
            .lock()
            .expect("messages")
            .iter()
            .map(|message| message.text.clone())
            .collect::<Vec<_>>();
        assert_eq!(message_texts, ["ab"]);
        assert_eq!(
            client.get_context_token("alice@im.wechat").as_deref(),
            Some("context-alice")
        );
        assert_eq!(observer.expired.load(Ordering::Acquire), 1);
        assert!(!client.is_running());
        let request_buffers = transport
            .update_requests
            .lock()
            .expect("requests")
            .iter()
            .map(|request| request.get_updates_buf.clone())
            .collect::<Vec<_>>();
        assert_eq!(request_buffers[0], "");
        assert_eq!(request_buffers[1], "cursor-2");
        client.stop().await;

        client.set_context_token("alice@im.wechat", "context-alice");
        client
            .send_text("alice@im.wechat", "reply", None)
            .await
            .expect("send");
        let sends = transport.sends.lock().expect("sends");
        assert_eq!(sends[0].context_token, "context-alice");
        assert!(
            sends[0]
                .client_id
                .strip_prefix(CLIENT_ID_PREFIX)
                .is_some_and(
                    |hex| hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                )
        );
    }

    #[tokio::test]
    async fn dropping_first_stop_future_does_not_strand_poll_cleanup() {
        let transport = Arc::new(FakeTransport::default());
        let observer = Arc::new(RecordingObserver::default());
        let client = Arc::new(WeixinClient::new(transport, Some(credentials())));
        client
            .start_polling(WeixinStartOptions::new(observer.clone()))
            .await
            .expect("start polling");

        let mut first_stop = Box::pin(client.stop());
        std::future::poll_fn(|context| {
            assert!(matches!(first_stop.as_mut().poll(context), Poll::Pending));
            Poll::Ready(())
        })
        .await;
        drop(first_stop);

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match client
                    .start_polling(WeixinStartOptions::new(observer.clone()))
                    .await
                {
                    Ok(()) => break,
                    Err(WeixinClientError::AlreadyRunning) => tokio::task::yield_now().await,
                    Err(error) => panic!("restart polling failed: {error}"),
                }
            }
        })
        .await
        .expect("independent cleanup reaches idle");
        client.stop().await;
        assert!(!client.is_running());
    }
}
