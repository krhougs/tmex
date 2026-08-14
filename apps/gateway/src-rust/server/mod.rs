use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{
    CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket, WebSocketUpgrade,
};
use axum::extract::State;
use axum::http::header::{ALLOW, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use tmex_protocol::DEFAULT_MAX_FRAME_BYTES;
use tokio::net::TcpListener;

use crate::ipc::{CloseFrame, GatewayClient, GatewayFrame, GatewaySession};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayFrontend {
    ApiOnly,
    Spa { root: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayServerConfig {
    pub host: String,
    pub port: u16,
    pub frontend: GatewayFrontend,
}

impl GatewayServerConfig {
    pub fn api_only(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            frontend: GatewayFrontend::ApiOnly,
        }
    }

    pub fn spa(host: impl Into<String>, port: u16, root: impl Into<PathBuf>) -> Self {
        Self {
            host: host.into(),
            port,
            frontend: GatewayFrontend::Spa { root: root.into() },
        }
    }
}

pub struct GatewayTcpServer {
    listener: TcpListener,
    local_addr: SocketAddr,
    router: Router,
}

impl GatewayTcpServer {
    pub async fn bind(client: GatewayClient, config: GatewayServerConfig) -> io::Result<Self> {
        let listener = TcpListener::bind((config.host.as_str(), config.port)).await?;
        let local_addr = listener.local_addr()?;
        let router = gateway_router(client, config.frontend);
        Ok(Self {
            listener,
            local_addr,
            router,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn serve<F>(self, shutdown: F) -> io::Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(shutdown)
            .await
    }
}

#[derive(Clone)]
struct GatewayServerState {
    client: GatewayClient,
    frontend: GatewayFrontend,
}

fn gateway_router(client: GatewayClient, frontend: GatewayFrontend) -> Router {
    let state = Arc::new(GatewayServerState { client, frontend });
    Router::new()
        .route("/ws", any(upgrade_websocket))
        .fallback(route_http)
        .with_state(state)
}

async fn upgrade_websocket(
    State(state): State<Arc<GatewayServerState>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let upgrade = upgrade
        .max_message_size(DEFAULT_MAX_FRAME_BYTES)
        .max_frame_size(DEFAULT_MAX_FRAME_BYTES);
    let session = match state.client.open_websocket().await {
        Ok(session) => session,
        Err(_) => return plain_response(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable"),
    };
    upgrade
        .on_upgrade(move |socket| bridge_websocket(socket, session))
        .into_response()
}

async fn bridge_websocket(socket: WebSocket, session: GatewaySession) {
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (session_sender, mut session_receiver) = session.into_split();

    let from_socket = async move {
        while let Some(result) = socket_receiver.next().await {
            let Ok(message) = result else {
                break;
            };
            let is_close = matches!(message, AxumMessage::Close(_));
            if session_sender
                .send(axum_to_gateway_frame(message))
                .await
                .is_err()
            {
                break;
            }
            if is_close {
                break;
            }
        }
    };

    let to_socket = async move {
        while let Some(frame) = session_receiver.recv().await {
            let is_close = matches!(frame, GatewayFrame::Close(_));
            if socket_sender
                .send(gateway_to_axum_frame(frame))
                .await
                .is_err()
            {
                break;
            }
            if is_close {
                let _ = socket_sender.flush().await;
                break;
            }
        }
    };

    tokio::pin!(from_socket);
    tokio::pin!(to_socket);
    tokio::select! {
        _ = &mut from_socket => {}
        _ = &mut to_socket => {}
    }
}

fn axum_to_gateway_frame(message: AxumMessage) -> GatewayFrame {
    match message {
        AxumMessage::Binary(payload) => GatewayFrame::Binary(payload),
        AxumMessage::Text(payload) => GatewayFrame::Text(payload.to_string()),
        AxumMessage::Ping(payload) => GatewayFrame::Ping(payload),
        AxumMessage::Pong(payload) => GatewayFrame::Pong(payload),
        AxumMessage::Close(frame) => GatewayFrame::Close(frame.map(|frame| CloseFrame {
            code: frame.code,
            reason: frame.reason.to_string(),
        })),
    }
}

fn gateway_to_axum_frame(frame: GatewayFrame) -> AxumMessage {
    match frame {
        GatewayFrame::Binary(payload) => AxumMessage::Binary(payload),
        GatewayFrame::Text(payload) => AxumMessage::Text(payload.into()),
        GatewayFrame::Ping(payload) => AxumMessage::Ping(payload),
        GatewayFrame::Pong(payload) => AxumMessage::Pong(payload),
        GatewayFrame::Close(frame) => AxumMessage::Close(frame.map(|frame| AxumCloseFrame {
            code: frame.code,
            reason: frame.reason.into(),
        })),
    }
}

async fn route_http(
    State(state): State<Arc<GatewayServerState>>,
    request: Request<Body>,
) -> Response {
    let path = request.uri().path();
    if is_gateway_http_path(path) {
        return match state.client.request(request).await {
            Ok(response) => response,
            Err(_) => plain_response(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable"),
        };
    }

    match &state.frontend {
        GatewayFrontend::ApiOnly => plain_response(StatusCode::NOT_FOUND, "Not Found"),
        GatewayFrontend::Spa { root } => serve_spa(request.method(), path, root).await,
    }
}

fn is_gateway_http_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/") || path == "/healthz"
}

async fn serve_spa(method: &Method, path: &str, root: &Path) -> Response {
    if method != Method::GET && method != Method::HEAD {
        let mut response = plain_response(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        response
            .headers_mut()
            .insert(ALLOW, axum::http::HeaderValue::from_static("GET, HEAD"));
        return response;
    }

    let relative = match decode_relative_path(path) {
        Ok(relative) => relative,
        Err(StaticPathError::Invalid) => {
            return plain_response(StatusCode::BAD_REQUEST, "Bad Request")
        }
        Err(StaticPathError::EscapesRoot) => {
            return plain_response(StatusCode::FORBIDDEN, "Forbidden")
        }
    };

    let canonical_root = match tokio::fs::canonicalize(root).await {
        Ok(root) => root,
        Err(_) => {
            return plain_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Frontend static assets not found",
            )
        }
    };
    match tokio::fs::metadata(&canonical_root).await {
        Ok(metadata) if metadata.is_dir() => {}
        _ => {
            return plain_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Frontend static assets not found",
            )
        }
    }

    let requested = if relative.as_os_str().is_empty() {
        PathBuf::from("index.html")
    } else {
        relative.clone()
    };
    let target = match resolve_static_file(&canonical_root, &requested).await {
        Ok(Some(target)) => target,
        Ok(None) if relative.extension().is_some() => {
            return plain_response(StatusCode::NOT_FOUND, "Not Found")
        }
        Ok(None) => match resolve_static_file(&canonical_root, Path::new("index.html")).await {
            Ok(Some(target)) => target,
            Ok(None) | Err(StaticFileError::Unavailable) => {
                return plain_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Frontend static assets not found",
                )
            }
            Err(StaticFileError::EscapesRoot) => {
                return plain_response(StatusCode::FORBIDDEN, "Forbidden")
            }
        },
        Err(StaticFileError::EscapesRoot) => {
            return plain_response(StatusCode::FORBIDDEN, "Forbidden")
        }
        Err(StaticFileError::Unavailable) => {
            return plain_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Frontend static assets not found",
            )
        }
    };

    let contents = match tokio::fs::read(&target.canonical).await {
        Ok(contents) => contents,
        Err(_) => {
            return plain_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Frontend static assets not found",
            )
        }
    };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_LENGTH, contents.len().to_string());
    if let Some(content_type) = content_type(&target.logical) {
        builder = builder.header(CONTENT_TYPE, content_type);
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(contents)
    };
    builder.body(body).unwrap_or_else(|_| {
        plain_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Frontend static assets not found",
        )
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StaticPathError {
    Invalid,
    EscapesRoot,
}

fn decode_relative_path(path: &str) -> Result<PathBuf, StaticPathError> {
    if !path.starts_with('/') || !has_valid_percent_encoding(path.as_bytes()) {
        return Err(StaticPathError::Invalid);
    }
    let decoded = percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| StaticPathError::Invalid)?;
    if decoded.contains('\0') {
        return Err(StaticPathError::Invalid);
    }
    if decoded.contains('\\') {
        return Err(StaticPathError::EscapesRoot);
    }

    let mut relative = PathBuf::new();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." || segment.contains(':') {
            return Err(StaticPathError::EscapesRoot);
        }
        let mut components = Path::new(segment).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(StaticPathError::EscapesRoot);
        }
        relative.push(segment);
    }
    Ok(relative)
}

fn has_valid_percent_encoding(input: &[u8]) -> bool {
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'%' {
            index += 1;
            continue;
        }
        if index + 2 >= input.len()
            || !input[index + 1].is_ascii_hexdigit()
            || !input[index + 2].is_ascii_hexdigit()
        {
            return false;
        }
        index += 3;
    }
    true
}

struct ResolvedStaticFile {
    canonical: PathBuf,
    logical: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StaticFileError {
    EscapesRoot,
    Unavailable,
}

async fn resolve_static_file(
    canonical_root: &Path,
    relative: &Path,
) -> Result<Option<ResolvedStaticFile>, StaticFileError> {
    let candidate = canonical_root.join(relative);
    let canonical = match tokio::fs::canonicalize(&candidate).await {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(StaticFileError::Unavailable),
    };
    if !canonical.starts_with(canonical_root) {
        return Err(StaticFileError::EscapesRoot);
    }
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|_| StaticFileError::Unavailable)?;
    if !metadata.is_file() {
        return Ok(None);
    }
    Ok(Some(ResolvedStaticFile {
        canonical,
        logical: relative.to_path_buf(),
    }))
}

fn content_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "html" => Some("text/html; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" | "map" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "txt" => Some("text/plain; charset=utf-8"),
        _ => None,
    }
}

fn plain_response(status: StatusCode, text: &'static str) -> Response {
    let mut response = Response::new(Body::from(text));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests;
