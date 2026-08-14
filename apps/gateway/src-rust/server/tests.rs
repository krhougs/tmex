use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http::{Response, StatusCode};
use tempfile::TempDir;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame as TungsteniteCloseFrame, Message};

use crate::ipc::{CloseFrame, GatewayCommand, GatewayFrame, GatewaySession};
use crate::lifecycle::LifecycleController;
use tmex_protocol::DEFAULT_MAX_FRAME_BYTES;

use super::{GatewayServerConfig, GatewayTcpServer};

struct RunningServer {
    addr: std::net::SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl RunningServer {
    async fn start(config: GatewayServerConfig) -> (Self, crate::ipc::GatewayIngress) {
        let (_, state) = LifecycleController::new();
        let (client, ingress) =
            crate::ipc::GatewayClient::channel(8, state).expect("valid capacity");
        let server = GatewayTcpServer::bind(client, config)
            .await
            .expect("bind loopback server");
        let addr = server.local_addr();
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(server.serve(async move {
            let _ = receiver.await;
        }));
        (
            Self {
                addr,
                shutdown: Some(shutdown),
                task,
            },
            ingress,
        )
    }

    fn http_url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    fn ws_url(&self, path: &str) -> String {
        format!("ws://{}{}", self.addr, path)
    }

    async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        timeout(Duration::from_secs(2), self.task)
            .await
            .expect("server shuts down")
            .expect("server task joins")
            .expect("server succeeds");
    }
}

fn reqwest_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("build client")
}

#[tokio::test]
async fn streams_http_request_and_response_bodies_without_aggregation() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (server, mut ingress) =
        RunningServer::start(GatewayServerConfig::api_only("127.0.0.1", 0)).await;

    let stream = tokio::net::TcpStream::connect(server.addr)
        .await
        .expect("connect raw streaming client");
    let (mut reader, mut writer) = stream.into_split();
    writer
        .write_all(
            b"POST /api/stream?preserve=yes HTTP/1.1\r\nHost: localhost\r\nx-original: preserved\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nfirst\r\n",
        )
        .await
        .expect("write first request chunk");
    let GatewayCommand::Http { request, response } =
        timeout(Duration::from_secs(2), ingress.recv())
            .await
            .expect("transport receives request before request EOF")
            .expect("HTTP command")
    else {
        panic!("expected HTTP command");
    };
    assert_eq!(request.method(), http::Method::POST);
    assert_eq!(request.uri(), "/api/stream?preserve=yes");
    assert_eq!(request.headers()["x-original"], "preserved");
    let mut body = request.into_body().into_data_stream();
    assert_eq!(
        timeout(Duration::from_secs(2), body.next())
            .await
            .expect("first request chunk arrives")
            .expect("request body remains open")
            .expect("valid request chunk"),
        "first"
    );

    let (response_chunks, response_body) = mpsc::channel::<Result<Bytes, Infallible>>(1);
    let response_stream = futures_util::stream::unfold(response_body, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    response
        .send(Ok(Response::builder()
            .status(StatusCode::CREATED)
            .header("x-response", "preserved")
            .body(Body::from_stream(response_stream))
            .expect("response")))
        .expect("return response");

    response_chunks
        .send(Ok(Bytes::from_static(b"alpha")))
        .await
        .expect("send first response chunk");
    let first_response = timeout(Duration::from_secs(2), async {
        let mut response = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = reader.read(&mut chunk).await.expect("read response bytes");
            assert!(count > 0, "response must not end before its first chunk");
            response.extend_from_slice(&chunk[..count]);
            if response
                .windows(b"alpha".len())
                .any(|window| window == b"alpha")
            {
                return response;
            }
        }
    })
    .await
    .expect("response starts before body EOF");
    let first_response = String::from_utf8(first_response).expect("HTTP response is UTF-8");
    assert!(first_response.starts_with("HTTP/1.1 201 Created"));
    assert!(first_response
        .to_ascii_lowercase()
        .contains("x-response: preserved"));
    assert!(first_response.contains("alpha"));

    writer
        .write_all(b"6\r\nsecond\r\n0\r\n\r\n")
        .await
        .expect("finish request stream");
    assert_eq!(
        body.next()
            .await
            .expect("second request chunk")
            .expect("valid request chunk"),
        "second"
    );
    assert!(body.next().await.is_none());

    response_chunks
        .send(Ok(Bytes::from_static(b"omega")))
        .await
        .expect("send second response chunk");
    drop(response_chunks);
    let mut remaining_response = Vec::new();
    reader
        .read_to_end(&mut remaining_response)
        .await
        .expect("finish response stream");
    assert!(String::from_utf8(remaining_response)
        .expect("HTTP response is UTF-8")
        .contains("omega"));
    server.stop().await;
}

#[tokio::test]
async fn bridges_all_websocket_frames_and_preserves_close_code_and_reason() {
    let (server, mut ingress) =
        RunningServer::start(GatewayServerConfig::api_only("127.0.0.1", 0)).await;
    let connect = tokio::spawn({
        let url = server.ws_url("/ws");
        async move { tokio_tungstenite::connect_async(url).await }
    });

    let GatewayCommand::OpenWebSocket { response } =
        timeout(Duration::from_secs(2), ingress.recv())
            .await
            .expect("upgrade reaches Gateway")
            .expect("open command")
    else {
        panic!("expected WebSocket command");
    };
    let (client_session, mut gateway_session) = GatewaySession::pair(8).expect("valid capacity");
    response
        .send(Ok(client_session))
        .expect("open in-process session");
    let (mut websocket, _) = connect
        .await
        .expect("connection task joins")
        .expect("upgrade succeeds");

    websocket
        .send(Message::Binary(Bytes::from_static(b"binary")))
        .await
        .expect("send binary");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Binary(Bytes::from_static(b"binary")))
    );
    websocket
        .send(Message::Text("text".into()))
        .await
        .expect("send text");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Text("text".to_owned()))
    );
    websocket
        .send(Message::Ping(Bytes::from_static(b"ping")))
        .await
        .expect("send ping");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Ping(Bytes::from_static(b"ping")))
    );
    websocket
        .send(Message::Pong(Bytes::from_static(b"pong")))
        .await
        .expect("send pong");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Pong(Bytes::from_static(b"pong")))
    );

    gateway_session
        .send(GatewayFrame::Text("server text".to_owned()))
        .await
        .expect("send server text");
    gateway_session
        .send(GatewayFrame::Ping(Bytes::from_static(b"server ping")))
        .await
        .expect("send server ping");
    gateway_session
        .send(GatewayFrame::Pong(Bytes::from_static(b"server pong")))
        .await
        .expect("send server pong");
    gateway_session
        .send(GatewayFrame::Binary(Bytes::from_static(b"reply")))
        .await
        .expect("send reply");
    assert_eq!(
        next_websocket_frame_ignoring_automatic_pong(&mut websocket).await,
        Message::Text("server text".into())
    );
    assert_eq!(
        next_websocket_frame_ignoring_automatic_pong(&mut websocket).await,
        Message::Ping(Bytes::from_static(b"server ping"))
    );
    assert_eq!(
        next_websocket_frame_ignoring_automatic_pong(&mut websocket).await,
        Message::Pong(Bytes::from_static(b"server pong"))
    );
    assert_eq!(
        next_websocket_frame_ignoring_automatic_pong(&mut websocket).await,
        Message::Binary(Bytes::from_static(b"reply"))
    );
    gateway_session
        .send(GatewayFrame::Close(Some(CloseFrame {
            code: 1012,
            reason: "service restart 重启".to_owned(),
        })))
        .await
        .expect("send close");
    let Message::Close(Some(close)) = websocket
        .next()
        .await
        .expect("close frame")
        .expect("valid close frame")
    else {
        panic!("expected close frame");
    };
    assert_eq!(u16::from(close.code), 1012);
    assert_eq!(close.reason, "service restart 重启");
    server.stop().await;
}

#[tokio::test]
async fn websocket_limits_reject_oversized_frames_and_messages_before_gateway_ipc() {
    let (server, mut ingress) =
        RunningServer::start(GatewayServerConfig::api_only("127.0.0.1", 0)).await;
    let connect = tokio::spawn({
        let url = server.ws_url("/ws");
        async move { tokio_tungstenite::connect_async(url).await }
    });
    let GatewayCommand::OpenWebSocket { response } = ingress.recv().await.expect("open command")
    else {
        panic!("expected WebSocket command");
    };
    let (client_session, mut gateway_session) = GatewaySession::pair(2).expect("valid capacity");
    response
        .send(Ok(client_session))
        .expect("open in-process session");
    let (mut websocket, _) = connect.await.expect("join connect").expect("upgrade");

    websocket
        .send(Message::Binary(Bytes::from_static(b"small")))
        .await
        .expect("send small frame");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Binary(Bytes::from_static(b"small")))
    );
    let oversized = Bytes::from(vec![0; DEFAULT_MAX_FRAME_BYTES + 1]);
    let _oversized_send_result = websocket.send(Message::Binary(oversized)).await;
    assert!(
        timeout(Duration::from_secs(2), gateway_session.recv())
            .await
            .expect("oversized frame closes the Gateway session")
            .is_none(),
        "oversized frame must not enter Gateway IPC"
    );
    drop(websocket);

    let connect = tokio::spawn({
        let url = server.ws_url("/ws");
        async move { tokio_tungstenite::connect_async(url).await }
    });
    let GatewayCommand::OpenWebSocket { response } = ingress.recv().await.expect("open command")
    else {
        panic!("expected WebSocket command");
    };
    let (client_session, mut gateway_session) = GatewaySession::pair(2).expect("valid capacity");
    response
        .send(Ok(client_session))
        .expect("open in-process session");
    let (mut websocket, _) = connect.await.expect("join connect").expect("upgrade");
    let fragment = Bytes::from(vec![0; DEFAULT_MAX_FRAME_BYTES / 2 + 1]);
    websocket
        .send(Message::Frame(Frame::message(
            fragment.clone(),
            OpCode::Data(Data::Binary),
            false,
        )))
        .await
        .expect("send first fragment");
    let _final_fragment_send_result = websocket
        .send(Message::Frame(Frame::message(
            fragment,
            OpCode::Data(Data::Continue),
            true,
        )))
        .await;
    assert!(
        timeout(Duration::from_secs(2), gateway_session.recv())
            .await
            .expect("oversized fragmented message closes the Gateway session")
            .is_none(),
        "oversized fragmented message must not enter Gateway IPC"
    );

    server.stop().await;
}

async fn next_websocket_frame_ignoring_automatic_pong<S>(
    websocket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Message
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let frame = websocket
            .next()
            .await
            .expect("WebSocket frame")
            .expect("valid frame");
        if frame != Message::Pong(Bytes::from_static(b"ping")) {
            return frame;
        }
    }
}

#[tokio::test]
async fn preserves_client_websocket_close_code_and_reason() {
    let (server, mut ingress) =
        RunningServer::start(GatewayServerConfig::api_only("127.0.0.1", 0)).await;
    let connect = tokio::spawn({
        let url = server.ws_url("/ws");
        async move { tokio_tungstenite::connect_async(url).await }
    });
    let GatewayCommand::OpenWebSocket { response } = ingress.recv().await.expect("open command")
    else {
        panic!("expected WebSocket command");
    };
    let (client_session, mut gateway_session) = GatewaySession::pair(2).expect("valid capacity");
    response
        .send(Ok(client_session))
        .expect("open in-process session");
    let (mut websocket, _) = connect.await.expect("join connect").expect("upgrade");
    websocket
        .send(Message::Close(Some(TungsteniteCloseFrame {
            code: 1000.into(),
            reason: "done 完成".into(),
        })))
        .await
        .expect("send close");
    assert_eq!(
        gateway_session.recv().await,
        Some(GatewayFrame::Close(Some(CloseFrame {
            code: 1000,
            reason: "done 完成".to_owned(),
        })))
    );
    server.stop().await;
}

#[tokio::test]
async fn spa_enforces_path_safety_head_and_fallback_rules() {
    let directory = TempDir::new().expect("temporary SPA root");
    tokio::fs::write(directory.path().join("index.html"), b"<main>spa</main>")
        .await
        .expect("write index");
    tokio::fs::create_dir(directory.path().join("assets"))
        .await
        .expect("create assets");
    tokio::fs::write(directory.path().join("assets/app.js"), b"export default 1")
        .await
        .expect("write asset");

    let (server, mut ingress) =
        RunningServer::start(GatewayServerConfig::spa("127.0.0.1", 0, directory.path())).await;
    let client = reqwest_client();

    let response = client
        .get(server.http_url("/client/route"))
        .send()
        .await
        .expect("fallback request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/html; charset=utf-8"
    );
    assert_eq!(response.text().await.expect("body"), "<main>spa</main>");

    let response = client
        .get(server.http_url("/missing.js"))
        .send()
        .await
        .expect("missing asset request");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);

    let response = client
        .head(server.http_url("/assets/app.js"))
        .send()
        .await
        .expect("HEAD request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert_eq!(response.headers()["content-length"], "16");
    assert!(response.bytes().await.expect("HEAD body").is_empty());

    for path in ["/%2e%2e/secret", "/..%2fsecret", "/%5c..%5csecret"] {
        assert!(
            raw_http_response(&server, path)
                .await
                .starts_with("HTTP/1.1 403 Forbidden"),
            "{path}"
        );
    }
    assert!(raw_http_response(&server, "/%ZZ")
        .await
        .starts_with("HTTP/1.1 400 Bad Request"));

    let websocket_without_upgrade = client
        .get(server.http_url("/ws"))
        .send()
        .await
        .expect("non-upgrade WebSocket request");
    assert_ne!(websocket_without_upgrade.status(), reqwest::StatusCode::OK);

    let api_request = tokio::spawn(client.get(server.http_url("/api/unhandled")).send());
    let GatewayCommand::Http { response, .. } = timeout(Duration::from_secs(2), ingress.recv())
        .await
        .expect("API routed to Gateway")
        .expect("HTTP command")
    else {
        panic!("expected HTTP command");
    };
    response
        .send(Ok(Response::builder()
            .status(StatusCode::IM_A_TEAPOT)
            .body(Body::from("gateway"))
            .expect("response")))
        .expect("return API response");
    assert_eq!(
        api_request
            .await
            .expect("API request task joins")
            .expect("API response")
            .status(),
        reqwest::StatusCode::IM_A_TEAPOT
    );
    assert!(timeout(Duration::from_millis(50), ingress.recv())
        .await
        .is_err());
    server.stop().await;
}

#[tokio::test]
async fn ipc_failures_return_a_minimal_503_without_internal_details() {
    let (server, ingress) =
        RunningServer::start(GatewayServerConfig::api_only("127.0.0.1", 0)).await;
    drop(ingress);

    let response = reqwest_client()
        .get(server.http_url("/api/capabilities"))
        .send()
        .await
        .expect("HTTP response");
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.text().await.expect("503 body"),
        "Service Unavailable"
    );
    server.stop().await;
}

async fn raw_http_response(server: &RunningServer, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let stream = tokio::net::TcpStream::connect(server.addr)
        .await
        .expect("raw HTTP connection");
    let (mut reader, mut writer) = stream.into_split();
    writer
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .expect("write raw request");
    let mut response = Vec::new();
    reader
        .read_to_end(&mut response)
        .await
        .expect("read raw response");
    String::from_utf8(response).expect("HTTP response is UTF-8")
}
