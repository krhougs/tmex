use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use futures_util::future::join_all;
use tokio::sync::{watch, Mutex};

use crate::crypto::{CryptoContext, MasterKey};
use crate::database::repository::CreatePendingTelegramChatInput;
use crate::entity::telegram_bots;
use crate::i18n::GatewayI18n;

use super::{
    TelegramBotToken, TelegramBotTransport, TelegramGetUpdatesRequest, TelegramOutgoingMessage,
    TelegramSendMessageRequest, TelegramServiceError, TelegramStore, TelegramTransportFactory,
    TelegramUpdate, TELEGRAM_LONG_POLL_TIMEOUT_SECONDS, TELEGRAM_POLL_RETRY_DELAY,
};

const NO_OFFSET: i64 = i64::MIN;

pub trait TelegramMessageFormatter: Send + Sync {
    fn gateway_online(&self, site_name: &str) -> String;
    fn auth_success(&self) -> String;
    fn auth_pending(&self) -> String;
    fn auth_failed(&self) -> String;
    fn bot_not_running(&self) -> String;
}

#[derive(Clone, Debug)]
pub struct GatewayTelegramMessageFormatter {
    i18n: GatewayI18n,
}

impl GatewayTelegramMessageFormatter {
    pub fn new(i18n: GatewayI18n) -> Self {
        Self { i18n }
    }
}

impl TelegramMessageFormatter for GatewayTelegramMessageFormatter {
    fn gateway_online(&self, site_name: &str) -> String {
        self.i18n.translate_with(
            "telegram.gatewayOnline",
            &HashMap::from([("siteName", site_name.to_owned())]),
        )
    }

    fn auth_success(&self) -> String {
        self.i18n.translate("telegram.authSuccess")
    }

    fn auth_pending(&self) -> String {
        self.i18n.translate("telegram.authPending")
    }

    fn auth_failed(&self) -> String {
        self.i18n.translate("telegram.authFailed")
    }

    fn bot_not_running(&self) -> String {
        self.i18n.translate("telegram.botNotRunning")
    }
}

pub struct TelegramServiceDependencies {
    pub store: Arc<dyn TelegramStore>,
    pub master_key: MasterKey,
    pub transport_factory: Arc<dyn TelegramTransportFactory>,
    pub formatter: Arc<dyn TelegramMessageFormatter>,
}

#[derive(Clone)]
pub struct TelegramService {
    inner: Arc<TelegramServiceInner>,
}

struct TelegramServiceInner {
    dependencies: TelegramServiceDependencies,
    lifecycle: Mutex<()>,
    running: Mutex<HashMap<String, RunningBot>>,
}

struct RunningBot {
    token: TelegramBotToken,
    transport: Arc<dyn TelegramBotTransport>,
    next_offset: Arc<AtomicI64>,
    cancel: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl TelegramService {
    pub fn new(dependencies: TelegramServiceDependencies) -> Self {
        Self {
            inner: Arc::new(TelegramServiceInner {
                dependencies,
                lifecycle: Mutex::new(()),
                running: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn refresh(&self) -> Result<(), TelegramServiceError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let configs = self.inner.dependencies.store.all_bots().await?;
        let active_ids = configs
            .iter()
            .map(|config| config.id.clone())
            .collect::<HashSet<_>>();
        let running_ids = self
            .inner
            .running
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for bot_id in running_ids {
            if !active_ids.contains(&bot_id) {
                self.stop_bot_locked(&bot_id).await?;
            }
        }

        for config in configs {
            if config.enabled == 0 {
                self.stop_bot_locked(&config.id).await?;
                continue;
            }
            let token = TelegramBotToken::new(
                self.inner.dependencies.master_key.decrypt_with_context(
                    &config.token_enc,
                    CryptoContext::new("telegram_bot")
                        .entity_id(&config.id)
                        .field("token_enc"),
                )?,
            );
            let unchanged = self
                .inner
                .running
                .lock()
                .await
                .get(&config.id)
                .is_some_and(|running| running.token == token);
            if unchanged {
                continue;
            }
            let resume_offset = if self.inner.running.lock().await.contains_key(&config.id) {
                self.stop_bot_locked(&config.id).await?
            } else {
                config.last_update_id
            };
            self.start_bot_locked(config, token, resume_offset).await?;
        }
        Ok(())
    }

    pub async fn send_gateway_online_message(
        &self,
        site_name: &str,
    ) -> Result<(), TelegramServiceError> {
        self.send_to_authorized_chats(TelegramOutgoingMessage::text(
            self.inner.dependencies.formatter.gateway_online(site_name),
        ))
        .await
    }

    pub async fn send_to_authorized_chats(
        &self,
        message: TelegramOutgoingMessage,
    ) -> Result<(), TelegramServiceError> {
        let running = self
            .inner
            .running
            .lock()
            .await
            .iter()
            .map(|(bot_id, running)| (bot_id.clone(), running.transport.clone()))
            .collect::<Vec<_>>();
        for (bot_id, transport) in running {
            let chats = self
                .inner
                .dependencies
                .store
                .authorized_chats(&bot_id)
                .await?;
            let sends = chats.into_iter().map(|chat| {
                let bot_id = bot_id.clone();
                let transport = transport.clone();
                let request = TelegramSendMessageRequest {
                    chat_id: chat.chat_id,
                    text: message.text.clone(),
                    parse_mode: message.parse_mode,
                };
                async move {
                    if let Err(error) = transport.send_message(request.clone()).await {
                        tracing::error!(
                            bot_id,
                            chat_id = request.chat_id,
                            error = %error,
                            "Telegram authorized broadcast failed"
                        );
                    }
                }
            });
            join_all(sends).await;
        }
        Ok(())
    }

    pub async fn send_test_message(
        &self,
        bot_id: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<(), TelegramServiceError> {
        let transport = self
            .inner
            .running
            .lock()
            .await
            .get(bot_id)
            .map(|running| running.transport.clone())
            .ok_or_else(|| TelegramServiceError::BotNotRunning {
                bot_id: bot_id.to_owned(),
                message: self.inner.dependencies.formatter.bot_not_running(),
            })?;
        transport
            .send_message(TelegramSendMessageRequest {
                chat_id: chat_id.to_owned(),
                text: text.to_owned(),
                parse_mode: None,
            })
            .await
            .map_err(|source| TelegramServiceError::Send {
                bot_id: bot_id.to_owned(),
                chat_id: chat_id.to_owned(),
                source,
            })
    }

    pub async fn sync_bot_offset(&self, bot_id: &str) -> Result<(), TelegramServiceError> {
        let offset = self
            .inner
            .running
            .lock()
            .await
            .get(bot_id)
            .and_then(|running| load_offset(&running.next_offset));
        if let Some(offset) = offset {
            self.inner
                .dependencies
                .store
                .persist_next_offset(bot_id, offset)
                .await?;
        }
        Ok(())
    }

    pub async fn stop_all(&self) -> Result<(), TelegramServiceError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let running = {
            let mut map = self.inner.running.lock().await;
            map.drain().collect::<Vec<_>>()
        };
        for (_, running) in &running {
            let _ = running.cancel.send(true);
            running.task.abort();
        }
        let mut first_error = None;
        for (bot_id, running) in running {
            if let Err(error) = self.finish_stopped_bot(&bot_id, running).await {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn start_bot_locked(
        &self,
        config: telegram_bots::Model,
        token: TelegramBotToken,
        offset: Option<i64>,
    ) -> Result<(), TelegramServiceError> {
        let transport = self
            .inner
            .dependencies
            .transport_factory
            .create(token.clone());
        transport
            .validate_bot()
            .await
            .map_err(|source| TelegramServiceError::Start {
                bot_id: config.id.clone(),
                source,
            })?;
        if let Some(offset) = offset {
            self.inner
                .dependencies
                .store
                .persist_next_offset(&config.id, offset)
                .await?;
        }
        let next_offset = Arc::new(AtomicI64::new(offset.unwrap_or(NO_OFFSET)));
        let (cancel, cancel_receiver) = watch::channel(false);
        let mut running = self.inner.running.lock().await;
        let task = tokio::spawn(poll_bot(
            config.id.clone(),
            transport.clone(),
            self.inner.dependencies.store.clone(),
            self.inner.dependencies.formatter.clone(),
            next_offset.clone(),
            cancel_receiver,
        ));
        running.insert(
            config.id.clone(),
            RunningBot {
                token,
                transport,
                next_offset,
                cancel,
                task,
            },
        );
        tracing::info!(bot_id = config.id, "Telegram bot started");
        Ok(())
    }

    async fn stop_bot_locked(&self, bot_id: &str) -> Result<Option<i64>, TelegramServiceError> {
        let Some(running) = self.inner.running.lock().await.remove(bot_id) else {
            return Ok(None);
        };
        let _ = running.cancel.send(true);
        running.task.abort();
        let offset = load_offset(&running.next_offset);
        self.finish_stopped_bot(bot_id, running).await?;
        tracing::info!(bot_id, "Telegram bot stopped");
        Ok(offset)
    }

    async fn finish_stopped_bot(
        &self,
        bot_id: &str,
        running: RunningBot,
    ) -> Result<(), TelegramServiceError> {
        let _ = running.task.await;
        if let Some(offset) = load_offset(&running.next_offset) {
            self.inner
                .dependencies
                .store
                .persist_next_offset(bot_id, offset)
                .await?;
        }
        Ok(())
    }
}

async fn poll_bot(
    bot_id: String,
    transport: Arc<dyn TelegramBotTransport>,
    store: Arc<dyn TelegramStore>,
    formatter: Arc<dyn TelegramMessageFormatter>,
    next_offset: Arc<AtomicI64>,
    mut cancel: watch::Receiver<bool>,
) {
    loop {
        if *cancel.borrow() {
            return;
        }
        let request = TelegramGetUpdatesRequest {
            offset: load_offset(&next_offset),
            timeout_seconds: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
        };
        let result = tokio::select! {
            result = transport.get_updates(request) => result,
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return;
                }
                continue;
            }
        };
        match result {
            Ok(updates) => {
                let mut highest_update_id = None;
                for update in updates {
                    highest_update_id =
                        Some(highest_update_id.map_or(update.update_id, |current: i64| {
                            current.max(update.update_id)
                        }));
                    handle_update(
                        &bot_id,
                        transport.as_ref(),
                        store.as_ref(),
                        formatter.as_ref(),
                        update,
                    )
                    .await;
                }
                if let Some(update_id) = highest_update_id {
                    let candidate = update_id.saturating_add(1);
                    let current = load_offset(&next_offset);
                    let offset = current.map_or(candidate, |current| current.max(candidate));
                    next_offset.store(offset, Ordering::Release);
                    if let Err(error) = store.persist_next_offset(&bot_id, offset).await {
                        tracing::error!(bot_id, error = %error, "Telegram offset persistence failed");
                    }
                }
            }
            Err(error) => {
                tracing::error!(bot_id, error = %error, "Telegram long poll failed");
                tokio::select! {
                    _ = tokio::time::sleep(TELEGRAM_POLL_RETRY_DELAY) => {}
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn handle_update(
    bot_id: &str,
    transport: &dyn TelegramBotTransport,
    store: &dyn TelegramStore,
    formatter: &dyn TelegramMessageFormatter,
    update: TelegramUpdate,
) {
    let Some(message) = update.message else {
        return;
    };
    if message.text.as_deref().map(trim_javascript) != Some("/start") {
        return;
    }
    match store.bot_by_id(bot_id).await {
        Ok(Some(latest)) if latest.allow_auth_requests != 0 => {}
        Ok(_) => return,
        Err(error) => {
            tracing::error!(bot_id, error = %error, "Telegram bot configuration refresh failed");
            return;
        }
    }
    let chat_id = message.chat.id.to_string();
    let display_name = build_chat_display_name(
        message.chat.title.as_deref(),
        message.chat.username.as_deref(),
        message
            .sender
            .as_ref()
            .and_then(|sender| sender.first_name.as_deref()),
        message
            .sender
            .as_ref()
            .and_then(|sender| sender.last_name.as_deref()),
        &chat_id,
    );
    let reply = match store
        .upsert_pending_chat(CreatePendingTelegramChatInput {
            bot_id: bot_id.to_owned(),
            chat_id: chat_id.clone(),
            chat_type: normalize_chat_type(&message.chat.kind).to_owned(),
            display_name,
            applied_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .await
    {
        Ok(chat) if chat.status == "authorized" => formatter.auth_success(),
        Ok(_) => formatter.auth_pending(),
        Err(error) => {
            tracing::error!(bot_id, chat_id, error = %error, "Telegram pending chat persistence failed");
            formatter.auth_failed()
        }
    };
    if let Err(error) = transport
        .send_message(TelegramSendMessageRequest {
            chat_id: chat_id.clone(),
            text: reply,
            parse_mode: None,
        })
        .await
    {
        tracing::error!(bot_id, chat_id, error = %error, "Telegram authorization reply failed");
    }
}

fn load_offset(offset: &AtomicI64) -> Option<i64> {
    match offset.load(Ordering::Acquire) {
        NO_OFFSET => None,
        value => Some(value),
    }
}

fn normalize_chat_type(value: &str) -> &'static str {
    match value {
        "private" => "private",
        "group" => "group",
        "supergroup" => "supergroup",
        "channel" => "channel",
        _ => "unknown",
    }
}

fn build_chat_display_name(
    title: Option<&str>,
    username: Option<&str>,
    first_name: Option<&str>,
    last_name: Option<&str>,
    fallback: &str,
) -> String {
    if let Some(title) = title.map(trim_javascript).filter(|value| !value.is_empty()) {
        return title.to_owned();
    }
    if let Some(username) = username
        .map(trim_javascript)
        .filter(|value| !value.is_empty())
    {
        return format!("@{username}");
    }
    let full_name = format!(
        "{} {}",
        first_name.unwrap_or_default(),
        last_name.unwrap_or_default()
    );
    let full_name = trim_javascript(&full_name);
    if full_name.is_empty() {
        fallback.to_owned()
    } else {
        full_name.to_owned()
    }
}

fn trim_javascript(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::pending;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex as StdMutex;

    use async_trait::async_trait;
    use tokio::sync::Semaphore;

    use crate::entity::telegram_bot_chats;

    use super::*;
    use crate::telegram::{
        TelegramChat, TelegramIncomingMessage, TelegramStoreError, TelegramTransportError,
        TelegramUser,
    };

    #[derive(Default)]
    struct FakeStoreState {
        bots: Vec<telegram_bots::Model>,
        upserts: Vec<CreatePendingTelegramChatInput>,
        offsets: Vec<(String, i64)>,
        authorized: Vec<telegram_bot_chats::Model>,
        bot_reads: usize,
    }

    struct FakeStore {
        state: StdMutex<FakeStoreState>,
        upserted: Semaphore,
    }

    impl Default for FakeStore {
        fn default() -> Self {
            Self {
                state: StdMutex::new(FakeStoreState::default()),
                upserted: Semaphore::new(0),
            }
        }
    }

    impl FakeStore {
        fn with_bot(bot: telegram_bots::Model) -> Self {
            Self {
                state: StdMutex::new(FakeStoreState {
                    bots: vec![bot],
                    ..FakeStoreState::default()
                }),
                ..Self::default()
            }
        }

        fn set_token(&self, token_enc: String) {
            self.state.lock().expect("fake store").bots[0].token_enc = token_enc;
        }

        fn set_enabled(&self, enabled: bool) {
            self.state.lock().expect("fake store").bots[0].enabled = i64::from(enabled);
        }

        fn remove_bots(&self) {
            self.state.lock().expect("fake store").bots.clear();
        }

        fn offsets(&self) -> Vec<(String, i64)> {
            self.state.lock().expect("fake store").offsets.clone()
        }
    }

    #[async_trait]
    impl TelegramStore for FakeStore {
        async fn all_bots(&self) -> Result<Vec<telegram_bots::Model>, TelegramStoreError> {
            Ok(self.state.lock().expect("fake store").bots.clone())
        }

        async fn bot_by_id(
            &self,
            bot_id: &str,
        ) -> Result<Option<telegram_bots::Model>, TelegramStoreError> {
            let mut state = self.state.lock().expect("fake store");
            state.bot_reads += 1;
            Ok(state.bots.iter().find(|bot| bot.id == bot_id).cloned())
        }

        async fn upsert_pending_chat(
            &self,
            input: CreatePendingTelegramChatInput,
        ) -> Result<telegram_bot_chats::Model, TelegramStoreError> {
            self.state
                .lock()
                .expect("fake store")
                .upserts
                .push(input.clone());
            self.upserted.add_permits(1);
            Ok(telegram_bot_chats::Model {
                id: "chat-record".to_owned(),
                bot_id: input.bot_id,
                chat_id: input.chat_id,
                chat_type: input.chat_type,
                display_name: input.display_name,
                status: "pending".to_owned(),
                applied_at: input.applied_at,
                authorized_at: None,
                updated_at: "now".to_owned(),
            })
        }

        async fn authorized_chats(
            &self,
            bot_id: &str,
        ) -> Result<Vec<telegram_bot_chats::Model>, TelegramStoreError> {
            Ok(self
                .state
                .lock()
                .expect("fake store")
                .authorized
                .iter()
                .filter(|chat| chat.bot_id == bot_id)
                .cloned()
                .collect())
        }

        async fn persist_next_offset(
            &self,
            bot_id: &str,
            offset: i64,
        ) -> Result<(), TelegramStoreError> {
            self.state
                .lock()
                .expect("fake store")
                .offsets
                .push((bot_id.to_owned(), offset));
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
        batches: StdMutex<VecDeque<Vec<TelegramUpdate>>>,
        requests: StdMutex<Vec<TelegramGetUpdatesRequest>>,
        messages: StdMutex<Vec<TelegramSendMessageRequest>>,
        poll_started: Semaphore,
        pending_poll_dropped: Arc<AtomicBool>,
    }

    impl FakeTransport {
        fn new(batches: Vec<Vec<TelegramUpdate>>) -> Self {
            Self {
                batches: StdMutex::new(batches.into()),
                requests: StdMutex::new(Vec::new()),
                messages: StdMutex::new(Vec::new()),
                poll_started: Semaphore::new(0),
                pending_poll_dropped: Arc::new(AtomicBool::new(false)),
            }
        }

        async fn wait_for_polls(&self, count: usize) {
            for _ in 0..count {
                self.poll_started
                    .acquire()
                    .await
                    .expect("poll semaphore")
                    .forget();
            }
        }
    }

    #[async_trait]
    impl TelegramBotTransport for FakeTransport {
        async fn validate_bot(&self) -> Result<(), TelegramTransportError> {
            Ok(())
        }

        async fn get_updates(
            &self,
            request: TelegramGetUpdatesRequest,
        ) -> Result<Vec<TelegramUpdate>, TelegramTransportError> {
            self.requests.lock().expect("fake transport").push(request);
            self.poll_started.add_permits(1);
            if let Some(batch) = self.batches.lock().expect("fake transport").pop_front() {
                return Ok(batch);
            }
            let _drop = PendingPollDrop(self.pending_poll_dropped.clone());
            pending().await
        }

        async fn send_message(
            &self,
            request: TelegramSendMessageRequest,
        ) -> Result<(), TelegramTransportError> {
            self.messages.lock().expect("fake transport").push(request);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeFactory {
        plans: StdMutex<VecDeque<Vec<Vec<TelegramUpdate>>>>,
        transports: StdMutex<Vec<Arc<FakeTransport>>>,
        tokens: StdMutex<Vec<String>>,
    }

    impl FakeFactory {
        fn push_plan(&self, batches: Vec<Vec<TelegramUpdate>>) {
            self.plans.lock().expect("fake factory").push_back(batches);
        }

        fn transports(&self) -> Vec<Arc<FakeTransport>> {
            self.transports.lock().expect("fake factory").clone()
        }
    }

    impl TelegramTransportFactory for FakeFactory {
        fn create(&self, token: TelegramBotToken) -> Arc<dyn TelegramBotTransport> {
            let transport = Arc::new(FakeTransport::new(
                self.plans
                    .lock()
                    .expect("fake factory")
                    .pop_front()
                    .unwrap_or_default(),
            ));
            self.tokens
                .lock()
                .expect("fake factory")
                .push(token.expose_secret().to_owned());
            self.transports
                .lock()
                .expect("fake factory")
                .push(transport.clone());
            transport
        }
    }

    struct FakeFormatter;

    impl TelegramMessageFormatter for FakeFormatter {
        fn gateway_online(&self, site_name: &str) -> String {
            format!("online {site_name}")
        }

        fn auth_success(&self) -> String {
            "authorized".to_owned()
        }

        fn auth_pending(&self) -> String {
            "pending".to_owned()
        }

        fn auth_failed(&self) -> String {
            "failed".to_owned()
        }

        fn bot_not_running(&self) -> String {
            "not running".to_owned()
        }
    }

    fn bot(key: &MasterKey, token: &str, offset: Option<i64>) -> telegram_bots::Model {
        telegram_bots::Model {
            id: "bot".to_owned(),
            name: "Bot".to_owned(),
            token_enc: key.encrypt(token).expect("encrypt token"),
            enabled: 1,
            allow_auth_requests: 1,
            last_update_id: offset,
            created_at: "now".to_owned(),
            updated_at: "now".to_owned(),
        }
    }

    fn service(
        store: Arc<FakeStore>,
        key: MasterKey,
        factory: Arc<FakeFactory>,
    ) -> TelegramService {
        TelegramService::new(TelegramServiceDependencies {
            store,
            master_key: key,
            transport_factory: factory,
            formatter: Arc::new(FakeFormatter),
        })
    }

    #[tokio::test]
    async fn refresh_reuses_unchanged_tokens_and_replaces_or_stops_exactly_one_runner() {
        let key = MasterKey::development_default();
        let store = Arc::new(FakeStore::with_bot(bot(&key, "token-one", None)));
        let factory = Arc::new(FakeFactory::default());
        let service = service(store.clone(), key.clone(), factory.clone());

        service.refresh().await.expect("start bot");
        let first = factory.transports()[0].clone();
        first.wait_for_polls(1).await;
        service.refresh().await.expect("reuse bot");
        assert_eq!(factory.transports().len(), 1);
        assert!(!first.pending_poll_dropped.load(Ordering::Acquire));

        store.set_token(key.encrypt("token-two").expect("encrypt changed token"));
        service.refresh().await.expect("replace bot");
        assert!(first.pending_poll_dropped.load(Ordering::Acquire));
        let second = factory.transports()[1].clone();
        second.wait_for_polls(1).await;

        store.set_enabled(false);
        service.refresh().await.expect("disable bot");
        assert!(second.pending_poll_dropped.load(Ordering::Acquire));
        store.set_enabled(true);
        service.refresh().await.expect("re-enable bot");
        let third = factory.transports()[2].clone();
        third.wait_for_polls(1).await;

        store.remove_bots();
        service.refresh().await.expect("remove bot");
        assert!(third.pending_poll_dropped.load(Ordering::Acquire));
        assert_eq!(
            factory.tokens.lock().expect("fake factory").as_slice(),
            ["token-one", "token-two", "token-two"]
        );
        let debug = format!("{:?}", TelegramBotToken::new("token-two".to_owned()));
        assert!(!debug.contains("token-two"));
    }

    #[tokio::test]
    async fn exact_start_persists_the_normalized_chat_and_replies_after_rereading_policy() {
        let key = MasterKey::development_default();
        let store = Arc::new(FakeStore::with_bot(bot(&key, "token", Some(10))));
        let factory = Arc::new(FakeFactory::default());
        factory.push_plan(vec![vec![
            TelegramUpdate {
                update_id: 41,
                message: Some(TelegramIncomingMessage {
                    text: Some(" \u{feff}/start\u{feff} ".to_owned()),
                    chat: TelegramChat {
                        id: -100,
                        kind: "unexpected".to_owned(),
                        title: Some(" \u{feff} ".to_owned()),
                        username: Some(" group_name ".to_owned()),
                    },
                    sender: Some(TelegramUser {
                        first_name: Some("Ignored".to_owned()),
                        last_name: None,
                    }),
                }),
            },
            TelegramUpdate {
                update_id: 42,
                message: Some(TelegramIncomingMessage {
                    text: Some("/start extra".to_owned()),
                    chat: TelegramChat {
                        id: -200,
                        kind: "group".to_owned(),
                        title: None,
                        username: None,
                    },
                    sender: None,
                }),
            },
        ]]);
        let service = service(store.clone(), key, factory.clone());

        service.refresh().await.expect("start bot");
        let transport = factory.transports()[0].clone();
        transport.wait_for_polls(2).await;
        store
            .upserted
            .acquire()
            .await
            .expect("pending chat persisted")
            .forget();

        let (bot_reads, upserts) = {
            let state = store.state.lock().expect("fake store");
            (state.bot_reads, state.upserts.clone())
        };
        assert_eq!(bot_reads, 1);
        assert_eq!(upserts.len(), 1);
        assert_eq!(upserts[0].chat_id, "-100");
        assert_eq!(upserts[0].chat_type, "unknown");
        assert_eq!(upserts[0].display_name, "@group_name");
        assert_eq!(
            transport
                .messages
                .lock()
                .expect("fake transport")
                .as_slice(),
            [TelegramSendMessageRequest {
                chat_id: "-100".to_owned(),
                text: "pending".to_owned(),
                parse_mode: None,
            }]
        );
        assert!(store.offsets().contains(&("bot".to_owned(), 43)));

        service.stop_all().await.expect("stop bot");
        assert!(transport.pending_poll_dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn next_offset_is_used_synced_and_preserved_when_the_pending_poll_is_cancelled() {
        let key = MasterKey::development_default();
        let store = Arc::new(FakeStore::with_bot(bot(&key, "token", Some(7))));
        let factory = Arc::new(FakeFactory::default());
        factory.push_plan(vec![vec![TelegramUpdate {
            update_id: 9,
            message: None,
        }]]);
        let service = service(store.clone(), key, factory.clone());

        service.refresh().await.expect("start bot");
        let transport = factory.transports()[0].clone();
        transport.wait_for_polls(2).await;
        service.sync_bot_offset("bot").await.expect("sync offset");
        service.stop_all().await.expect("stop bot");

        let requests = transport.requests.lock().expect("fake transport");
        assert_eq!(requests[0].offset, Some(7));
        assert_eq!(requests[0].timeout_seconds, 30);
        assert_eq!(requests[1].offset, Some(10));
        assert!(store.offsets().contains(&("bot".to_owned(), 10)));
        assert!(transport.pending_poll_dropped.load(Ordering::Acquire));
    }
}
