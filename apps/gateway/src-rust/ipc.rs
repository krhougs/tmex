use axum::body::Body;
use bytes::Bytes;
use http::{Request, Response};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};

use crate::lifecycle::GatewayState;

pub const DEFAULT_COMMAND_CAPACITY: usize = 128;
pub const DEFAULT_FRAME_CAPACITY: usize = 128;

type ShutdownRequest = oneshot::Sender<Result<(), IpcError>>;
pub(crate) type GatewayIngressReceivers<'a> = (
    &'a mut mpsc::Receiver<GatewayCommand>,
    &'a mut mpsc::Receiver<ShutdownRequest>,
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseFrame {
    pub code: u16,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayFrame {
    Binary(Bytes),
    Text(String),
    Ping(Bytes),
    Pong(Bytes),
    Close(Option<CloseFrame>),
}

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("Gateway IPC capacity must be positive")]
    InvalidCapacity,
    #[error("Gateway command channel is closed")]
    CommandChannelClosed,
    #[error("Gateway dropped an in-process response")]
    ResponseDropped,
    #[error("Gateway frame channel is closed")]
    FrameChannelClosed,
    #[error("Gateway frame channel is full")]
    FrameChannelFull,
    #[error("Gateway request failed: {0}")]
    Request(String),
}

pub enum GatewayCommand {
    Http {
        request: Box<Request<Body>>,
        response: oneshot::Sender<Result<Response<Body>, IpcError>>,
    },
    OpenWebSocket {
        response: oneshot::Sender<Result<GatewaySession, IpcError>>,
    },
    Shutdown {
        response: oneshot::Sender<Result<(), IpcError>>,
    },
}

#[derive(Clone)]
pub struct GatewayClient {
    commands: mpsc::Sender<GatewayCommand>,
    shutdown: mpsc::Sender<ShutdownRequest>,
    state: watch::Receiver<GatewayState>,
}

impl GatewayClient {
    pub fn channel(
        command_capacity: usize,
        state: watch::Receiver<GatewayState>,
    ) -> Result<(Self, GatewayIngress), IpcError> {
        if command_capacity == 0 {
            return Err(IpcError::InvalidCapacity);
        }
        let (commands, receiver) = mpsc::channel(command_capacity);
        let (shutdown, shutdown_receiver) = mpsc::channel(1);
        Ok((
            Self {
                commands,
                shutdown,
                state,
            },
            GatewayIngress {
                receiver,
                shutdown_receiver,
            },
        ))
    }

    pub fn state(&self) -> GatewayState {
        self.state.borrow().clone()
    }

    pub fn subscribe_state(&self) -> watch::Receiver<GatewayState> {
        self.state.clone()
    }

    pub async fn request(&self, request: Request<Body>) -> Result<Response<Body>, IpcError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(GatewayCommand::Http {
                request: Box::new(request),
                response,
            })
            .await
            .map_err(|_| IpcError::CommandChannelClosed)?;
        receiver.await.map_err(|_| IpcError::ResponseDropped)?
    }

    pub async fn open_websocket(&self) -> Result<GatewaySession, IpcError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(GatewayCommand::OpenWebSocket { response })
            .await
            .map_err(|_| IpcError::CommandChannelClosed)?;
        receiver.await.map_err(|_| IpcError::ResponseDropped)?
    }

    pub async fn shutdown(&self) -> Result<(), IpcError> {
        let (response, receiver) = oneshot::channel();
        self.shutdown
            .send(response)
            .await
            .map_err(|_| IpcError::CommandChannelClosed)?;
        receiver.await.map_err(|_| IpcError::ResponseDropped)?
    }
}

pub struct GatewayIngress {
    receiver: mpsc::Receiver<GatewayCommand>,
    shutdown_receiver: mpsc::Receiver<ShutdownRequest>,
}

impl GatewayIngress {
    pub async fn recv(&mut self) -> Option<GatewayCommand> {
        tokio::select! {
            biased;
            Some(response) = self.shutdown_receiver.recv() => {
                Some(GatewayCommand::Shutdown { response })
            }
            command = self.receiver.recv() => command,
        }
    }

    pub(crate) fn receivers(&mut self) -> GatewayIngressReceivers<'_> {
        (&mut self.receiver, &mut self.shutdown_receiver)
    }

    pub fn close(&mut self) {
        self.receiver.close();
        self.shutdown_receiver.close();
    }

    pub(crate) fn try_recv_shutdown(
        &mut self,
    ) -> Result<ShutdownRequest, mpsc::error::TryRecvError> {
        self.shutdown_receiver.try_recv()
    }
}

#[derive(Debug)]
pub struct GatewaySession {
    sender: GatewaySessionSender,
    receiver: GatewaySessionReceiver,
}

#[derive(Clone, Debug)]
pub struct GatewaySessionSender {
    sender: mpsc::Sender<GatewayFrame>,
    queued_bytes: Arc<AtomicUsize>,
}

#[derive(Debug)]
pub struct GatewaySessionReceiver {
    receiver: mpsc::Receiver<GatewayFrame>,
    queued_bytes: Arc<AtomicUsize>,
}

impl GatewaySession {
    pub fn pair(capacity: usize) -> Result<(Self, Self), IpcError> {
        Self::pair_with_server_outbound_counter(capacity, Arc::new(AtomicUsize::new(0)))
    }

    pub(crate) fn pair_with_server_outbound_counter(
        capacity: usize,
        server_to_client_bytes: Arc<AtomicUsize>,
    ) -> Result<(Self, Self), IpcError> {
        if capacity == 0 {
            return Err(IpcError::InvalidCapacity);
        }
        let (client_to_server_tx, client_to_server_rx) = mpsc::channel(capacity);
        let (server_to_client_tx, server_to_client_rx) = mpsc::channel(capacity);
        let client_to_server_bytes = Arc::new(AtomicUsize::new(0));
        Ok((
            Self {
                sender: GatewaySessionSender {
                    sender: client_to_server_tx,
                    queued_bytes: client_to_server_bytes.clone(),
                },
                receiver: GatewaySessionReceiver {
                    receiver: server_to_client_rx,
                    queued_bytes: server_to_client_bytes.clone(),
                },
            },
            Self {
                sender: GatewaySessionSender {
                    sender: server_to_client_tx,
                    queued_bytes: server_to_client_bytes,
                },
                receiver: GatewaySessionReceiver {
                    receiver: client_to_server_rx,
                    queued_bytes: client_to_server_bytes,
                },
            },
        ))
    }

    pub async fn send(&self, frame: GatewayFrame) -> Result<(), IpcError> {
        self.sender.send(frame).await
    }

    pub fn try_send(&self, frame: GatewayFrame) -> Result<(), IpcError> {
        self.sender.try_send(frame)
    }

    pub async fn recv(&mut self) -> Option<GatewayFrame> {
        self.receiver.recv().await
    }

    pub fn close(&mut self) {
        self.receiver.close();
    }

    pub fn into_split(self) -> (GatewaySessionSender, GatewaySessionReceiver) {
        (self.sender, self.receiver)
    }

    pub fn send_capacity(&self) -> usize {
        self.sender.capacity()
    }

    pub fn queued_send_bytes(&self) -> usize {
        self.sender.queued_bytes()
    }
}

impl GatewaySessionSender {
    pub async fn send(&self, frame: GatewayFrame) -> Result<(), IpcError> {
        let bytes = frame_size(&frame);
        let mut reservation = QueuedByteReservation::new(self.queued_bytes.clone(), bytes);
        if self.sender.send(frame).await.is_err() {
            return Err(IpcError::FrameChannelClosed);
        }
        reservation.commit();
        Ok(())
    }

    pub(crate) async fn send_precounted(&self, frame: GatewayFrame) -> Result<(), IpcError> {
        self.sender
            .send(frame)
            .await
            .map_err(|_| IpcError::FrameChannelClosed)
    }

    pub fn try_send(&self, frame: GatewayFrame) -> Result<(), IpcError> {
        let bytes = frame_size(&frame);
        self.queued_bytes.fetch_add(bytes, Ordering::AcqRel);
        match self.sender.try_send(frame) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                Err(IpcError::FrameChannelFull)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                Err(IpcError::FrameChannelClosed)
            }
        }
    }

    pub fn capacity(&self) -> usize {
        self.sender.capacity()
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::Acquire)
    }
}

struct QueuedByteReservation {
    queued_bytes: Arc<AtomicUsize>,
    bytes: usize,
    committed: bool,
}

impl QueuedByteReservation {
    fn new(queued_bytes: Arc<AtomicUsize>, bytes: usize) -> Self {
        queued_bytes.fetch_add(bytes, Ordering::AcqRel);
        Self {
            queued_bytes,
            bytes,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for QueuedByteReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.queued_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        }
    }
}

impl GatewaySessionReceiver {
    pub async fn recv(&mut self) -> Option<GatewayFrame> {
        let frame = self.receiver.recv().await?;
        self.queued_bytes
            .fetch_sub(frame_size(&frame), Ordering::AcqRel);
        Some(frame)
    }

    pub fn close(&mut self) {
        self.receiver.close();
    }
}

impl Drop for GatewaySessionReceiver {
    fn drop(&mut self) {
        while let Ok(frame) = self.receiver.try_recv() {
            self.queued_bytes
                .fetch_sub(frame_size(&frame), Ordering::AcqRel);
        }
    }
}

fn frame_size(frame: &GatewayFrame) -> usize {
    match frame {
        GatewayFrame::Binary(bytes) | GatewayFrame::Ping(bytes) | GatewayFrame::Pong(bytes) => {
            bytes.len()
        }
        GatewayFrame::Text(text) => text.len(),
        GatewayFrame::Close(Some(frame)) => 2usize.saturating_add(frame.reason.len()),
        GatewayFrame::Close(None) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::LifecycleController;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn carries_http_bodies_without_a_listener() {
        let (_, state) = LifecycleController::new();
        let (client, mut ingress) = GatewayClient::channel(2, state).expect("valid capacity");
        let server = tokio::spawn(async move {
            let GatewayCommand::Http { request, response } =
                ingress.recv().await.expect("HTTP command")
            else {
                panic!("expected HTTP command");
            };
            let request_body = request
                .into_body()
                .collect()
                .await
                .expect("collect request")
                .to_bytes();
            response
                .send(Ok(Response::new(Body::from(request_body))))
                .expect("return response");
        });

        let response = client
            .request(
                Request::builder()
                    .uri("/api/capabilities")
                    .body(Body::from("payload"))
                    .expect("request"),
            )
            .await
            .expect("IPC response");
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .expect("collect response")
                .to_bytes(),
            "payload"
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn opens_independent_bounded_duplex_sessions() {
        let (_, state) = LifecycleController::new();
        let (client, mut ingress) = GatewayClient::channel(2, state).expect("valid capacity");
        let server = tokio::spawn(async move {
            let GatewayCommand::OpenWebSocket { response } =
                ingress.recv().await.expect("open command")
            else {
                panic!("expected WebSocket command");
            };
            let (client_session, mut server_session) =
                GatewaySession::pair(2).expect("valid capacity");
            response
                .send(Ok(client_session))
                .expect("return client session");
            assert_eq!(
                server_session.recv().await,
                Some(GatewayFrame::Binary(Bytes::from_static(b"request")))
            );
            server_session
                .send(GatewayFrame::Binary(Bytes::from_static(b"response")))
                .await
                .expect("send response");
        });

        let mut session = client.open_websocket().await.expect("open session");
        session
            .send(GatewayFrame::Binary(Bytes::from_static(b"request")))
            .await
            .expect("send request");
        assert_eq!(
            session.recv().await,
            Some(GatewayFrame::Binary(Bytes::from_static(b"response")))
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn shutdown_bypasses_a_full_command_queue() {
        let (_, state) = LifecycleController::new();
        let (client, mut ingress) = GatewayClient::channel(1, state).expect("valid capacity");
        let (response, _receiver) = oneshot::channel();
        client
            .commands
            .send(GatewayCommand::OpenWebSocket { response })
            .await
            .expect("fill command queue");

        let shutdown = tokio::spawn({
            let client = client.clone();
            async move { client.shutdown().await }
        });
        let (_, shutdown_receiver) = ingress.receivers();
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_receiver.recv())
                .await
                .expect("shutdown channel remains responsive")
                .expect("shutdown request");
        response.send(Ok(())).expect("acknowledge shutdown");

        shutdown
            .await
            .expect("shutdown task")
            .expect("shutdown succeeds");
    }

    #[tokio::test]
    async fn cancelled_bounded_send_releases_queued_byte_reservation() {
        let (client, _server) = GatewaySession::pair(1).expect("valid capacity");
        client
            .send(GatewayFrame::Binary(Bytes::from_static(b"first")))
            .await
            .expect("fill bounded channel");
        assert_eq!(client.queued_send_bytes(), 5);

        let sender = client.sender.clone();
        let pending = tokio::spawn(async move {
            sender
                .send(GatewayFrame::Binary(Bytes::from_static(b"pending")))
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while client.queued_send_bytes() != 12 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pending send should reserve its queued bytes");
        assert_eq!(client.queued_send_bytes(), 12);

        pending.abort();
        let _ = pending.await;
        assert_eq!(client.queued_send_bytes(), 5);
    }
}
