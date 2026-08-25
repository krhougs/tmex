use axum::body::{to_bytes, Body};
use bytes::Bytes;
use futures_util::{stream, FutureExt};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use http::{HeaderValue, Method, Request, Response, StatusCode, Uri};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::{json as json_value, Map as JsonMap, Value as JsonValue};
use std::convert::Infallible;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use crate::database::repository::{CreateFileRootInput, RepositoryError, UpdateFileRootInput};
use crate::entity::file_roots;
use crate::files::{
    AppendUploadError, DownloadSession, FileCancellation, FileError, FileErrorCode, PulledFile,
    RsyncProgress, TransferManager, PASTE_IMAGE_MAX_BYTES, RAW_MAX_BYTES, UPLOAD_CHUNK_BODY_LIMIT,
    UPLOAD_CHUNK_SIZE,
};

use super::dto::SettingsNamespace;
use super::handler::HttpHandler;
use super::response::{error_json, json, HandlerError, HttpResponse};

const JSON_BODY_LIMIT: usize = 64 * 1024;
const STREAM_BUFFER: usize = 16;
const FILE_READ_BUFFER: usize = 64 * 1024;
const FILE_NAME_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub async fn handle_files_request(
    handler: &HttpHandler,
    request: Request<Body>,
) -> Option<HttpResponse> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();

    let response = if path == "/api/files/roots" && method == Method::GET {
        handle_list_roots(handler).await
    } else if path == "/api/files/roots" && method == Method::POST {
        handle_create_root(handler, request).await
    } else if path == "/api/files/list" && method == Method::GET {
        handle_list(handler, request.uri()).await
    } else if path == "/api/files/content" && method == Method::GET {
        handle_content(handler, request.uri()).await
    } else if path == "/api/files/stat" && method == Method::GET {
        handle_stat(handler, request.uri()).await
    } else if path == "/api/files/raw" && method == Method::GET {
        handle_raw(handler, request.uri()).await
    } else if path == "/api/files/download" && method == Method::GET {
        handle_download(handler, request.uri()).await
    } else if path == "/api/files/download/prepare" && method == Method::POST {
        Ok(handle_download_prepare(handler, request))
    } else if path == "/api/files/upload/init" && method == Method::POST {
        handle_upload_init(handler, request).await
    } else {
        let segments = path
            .strip_prefix('/')
            .unwrap_or(&path)
            .split('/')
            .collect::<Vec<_>>();
        match segments.as_slice() {
            ["api", "files", "roots", raw_id] if method == Method::PATCH => {
                match decode_component(raw_id) {
                    Ok(id) => handle_update_root(handler, request, &id).await,
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "roots", raw_id] if method == Method::DELETE => {
                match decode_component(raw_id) {
                    Ok(id) => handle_delete_root(handler, &id).await,
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "download", raw_id, "content"] if method == Method::GET => {
                match decode_component(raw_id) {
                    Ok(id) => handle_download_content(handler, &id).await,
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "download", raw_id] if method == Method::DELETE => {
                match decode_component(raw_id) {
                    Ok(id) => {
                        handler.files.transfers().remove_download(&id);
                        Ok(json(StatusCode::OK, &json_value!({ "success": true })))
                    }
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "upload", raw_id, "commit"] if method == Method::POST => {
                match decode_component(raw_id) {
                    Ok(id) => handle_upload_commit(handler, id).await,
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "upload", raw_id] if method == Method::PUT => {
                match decode_component(raw_id) {
                    Ok(id) => handle_upload_chunk(handler, request, &id).await,
                    Err(error) => Ok(code_error(error)),
                }
            }
            ["api", "files", "upload", raw_id] if method == Method::DELETE => {
                match decode_component(raw_id) {
                    Ok(id) => {
                        handler.files.transfers().remove_upload(&id);
                        Ok(json(StatusCode::OK, &json_value!({ "success": true })))
                    }
                    Err(error) => Ok(code_error(error)),
                }
            }
            _ => return None,
        }
    };

    Some(response.unwrap_or_else(|error| files_handler_error(handler, error)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRootDto {
    id: String,
    device_id: String,
    device_name: Option<String>,
    device_type: Option<String>,
    path: String,
    name: String,
    enabled: bool,
    sort_order: i64,
}

async fn root_dto(
    handler: &HttpHandler,
    root: file_roots::Model,
) -> Result<FileRootDto, FilesHandlerError> {
    let device = handler.repository.get_device_by_id(&root.device_id).await?;
    let name = root_display_name(&root.path);
    Ok(FileRootDto {
        id: root.id,
        device_id: root.device_id,
        device_name: device.as_ref().map(|device| device.name.clone()),
        device_type: device.map(|device| device.r#type),
        path: root.path,
        name,
        enabled: root.enabled != 0,
        sort_order: root.sort_order,
    })
}

async fn handle_list_roots(handler: &HttpHandler) -> FilesHandlerResult {
    let mut roots = Vec::new();
    for root in handler.repository.get_file_roots().await? {
        roots.push(root_dto(handler, root).await?);
    }
    Ok(json(StatusCode::OK, &json_value!({ "roots": roots })))
}

async fn handle_create_root(handler: &HttpHandler, request: Request<Body>) -> FilesHandlerResult {
    let body = collect_object(request.into_body()).await?;
    let device_id = body
        .get("deviceId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let path = body
        .get("path")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim();
    if device_id.is_empty()
        || handler
            .repository
            .get_device_by_id(device_id)
            .await?
            .is_none()
    {
        return Ok(error_json(
            StatusCode::BAD_REQUEST,
            &handler.translate("apiError.fileRootDeviceInvalid"),
        ));
    }
    if path.is_empty() || !path.starts_with('/') {
        return Ok(error_json(
            StatusCode::BAD_REQUEST,
            &handler.translate("apiError.fileRootInvalid"),
        ));
    }
    if handler
        .repository
        .get_file_roots()
        .await?
        .iter()
        .any(|root| root.device_id == device_id && root.path == path)
    {
        return Ok(error_json(
            StatusCode::BAD_REQUEST,
            &handler.translate("apiError.fileRootDuplicate"),
        ));
    }
    let enabled = match body.get("enabled") {
        None | Some(JsonValue::Null) => true,
        Some(JsonValue::Bool(enabled)) => *enabled,
        Some(_) => return Ok(invalid_request(handler)),
    };
    let root = handler
        .repository
        .create_file_root(CreateFileRootInput {
            device_id: device_id.to_owned(),
            path: path.to_owned(),
            enabled: Some(enabled),
        })
        .await?;
    handler
        .runtime
        .settings_changed(SettingsNamespace::FileRoots)
        .await?;
    Ok(json(
        StatusCode::CREATED,
        &json_value!({ "root": root_dto(handler, root).await? }),
    ))
}

async fn handle_update_root(
    handler: &HttpHandler,
    request: Request<Body>,
    id: &str,
) -> FilesHandlerResult {
    let Some(existing) = handler.repository.get_file_root_by_id(id).await? else {
        return Ok(error_json(
            StatusCode::NOT_FOUND,
            &handler.translate("apiError.notFound"),
        ));
    };
    let body = collect_object(request.into_body()).await?;
    let mut updates = UpdateFileRootInput::default();
    if let Some(value) = body.get("path") {
        let path = value.as_str().unwrap_or_default().trim();
        if path.is_empty() || !path.starts_with('/') {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &handler.translate("apiError.fileRootInvalid"),
            ));
        }
        if handler
            .repository
            .get_file_roots()
            .await?
            .iter()
            .any(|root| root.id != id && root.device_id == existing.device_id && root.path == path)
        {
            return Ok(error_json(
                StatusCode::BAD_REQUEST,
                &handler.translate("apiError.fileRootDuplicate"),
            ));
        }
        updates.path = Some(path.to_owned());
    }
    if let Some(value) = body.get("enabled") {
        let Some(enabled) = value.as_bool() else {
            return Ok(invalid_request(handler));
        };
        updates.enabled = Some(enabled);
    }
    if let Some(value) = body.get("sortOrder") {
        let Some(sort_order) = value.as_i64() else {
            return Ok(invalid_request(handler));
        };
        updates.sort_order = Some(sort_order);
    }
    let Some(root) = handler.repository.update_file_root(id, updates).await? else {
        return Ok(error_json(
            StatusCode::NOT_FOUND,
            &handler.translate("apiError.notFound"),
        ));
    };
    handler
        .runtime
        .settings_changed(SettingsNamespace::FileRoots)
        .await?;
    Ok(json(
        StatusCode::OK,
        &json_value!({ "root": root_dto(handler, root).await? }),
    ))
}

async fn handle_delete_root(handler: &HttpHandler, id: &str) -> FilesHandlerResult {
    if !handler.repository.delete_file_root(id).await? {
        return Ok(error_json(
            StatusCode::NOT_FOUND,
            &handler.translate("apiError.notFound"),
        ));
    }
    handler
        .runtime
        .settings_changed(SettingsNamespace::FileRoots)
        .await?;
    Ok(json(StatusCode::OK, &json_value!({ "success": true })))
}

async fn handle_list(handler: &HttpHandler, uri: &Uri) -> FilesHandlerResult {
    let Some(root_id) = query_parameter(uri, "rootId") else {
        return Ok(invalid_request(handler));
    };
    let path = query_parameter(uri, "path");
    match handler
        .files
        .list_directory(&root_id, path.as_deref())
        .await
    {
        Ok(result) => Ok(json(StatusCode::OK, &result)),
        Err(error) => Ok(code_error(error)),
    }
}

async fn handle_content(handler: &HttpHandler, uri: &Uri) -> FilesHandlerResult {
    let (Some(root_id), Some(path)) =
        (query_parameter(uri, "rootId"), query_parameter(uri, "path"))
    else {
        return Ok(invalid_request(handler));
    };
    match handler.files.read_text_file(&root_id, &path).await {
        Ok(result) => Ok(json(StatusCode::OK, &result)),
        Err(error) => Ok(code_error(error)),
    }
}

async fn handle_stat(handler: &HttpHandler, uri: &Uri) -> FilesHandlerResult {
    let (Some(root_id), Some(path)) =
        (query_parameter(uri, "rootId"), query_parameter(uri, "path"))
    else {
        return Ok(invalid_request(handler));
    };
    match handler.files.stat_file(&root_id, &path).await {
        Ok(result) => Ok(json(StatusCode::OK, &result)),
        Err(error) => Ok(code_error(error)),
    }
}

async fn handle_raw(handler: &HttpHandler, uri: &Uri) -> FilesHandlerResult {
    let (Some(root_id), Some(path)) =
        (query_parameter(uri, "rootId"), query_parameter(uri, "path"))
    else {
        return Ok(invalid_request(handler));
    };
    let cancellation = FileCancellation::new();
    let mut guard = CancelOnDrop::new(cancellation.clone());
    let file = match handler
        .files
        .pull_file(&root_id, &path, Some(RAW_MAX_BYTES), cancellation, None)
        .await
    {
        Ok(file) => file,
        Err(error) => return Ok(code_error(error)),
    };
    guard.disarm();
    let download = matches!(
        query_parameter(uri, "download").as_deref(),
        Some("1" | "true")
    );
    stream_file_response(file, download, false).await
}

async fn handle_download(handler: &HttpHandler, uri: &Uri) -> FilesHandlerResult {
    let (Some(root_id), Some(path)) =
        (query_parameter(uri, "rootId"), query_parameter(uri, "path"))
    else {
        return Ok(invalid_request(handler));
    };
    let cancellation = FileCancellation::new();
    let mut guard = CancelOnDrop::new(cancellation.clone());
    let (progress_sender, mut progress_receiver) = mpsc::channel(STREAM_BUFFER);
    let drain = tokio::spawn(async move { while progress_receiver.recv().await.is_some() {} });
    let file = match handler
        .files
        .pull_file(&root_id, &path, None, cancellation, Some(progress_sender))
        .await
    {
        Ok(file) => file,
        Err(error) => {
            drain.abort();
            return Ok(code_error(error));
        }
    };
    drain.abort();
    guard.disarm();
    stream_file_response(file, true, true).await
}

fn handle_download_prepare(handler: &HttpHandler, request: Request<Body>) -> HttpResponse {
    let service = handler.files.clone();
    let body = request.into_body();
    let cancellation = FileCancellation::new();
    let stream_cancellation = cancellation.clone();
    let (events, receiver) = mpsc::channel(STREAM_BUFFER);
    tokio::spawn(async move {
        let body = match tokio::select! {
            _ = cancellation.cancelled() => return,
            result = collect_object(body) => result,
        } {
            Ok(body) => body,
            Err(_) => {
                let _ =
                    send_event(&events, json_value!({ "type": "error", "code": "invalid" })).await;
                return;
            }
        };
        let root_id = body
            .get("rootId")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        let path = body
            .get("path")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        if root_id.is_empty() || path.is_empty() {
            let _ = send_event(&events, json_value!({ "type": "error", "code": "invalid" })).await;
            return;
        }
        let (progress_sender, mut progress) = mpsc::channel(STREAM_BUFFER);
        let operation = service.pull_file(
            root_id,
            path,
            None,
            cancellation.clone(),
            Some(progress_sender),
        );
        tokio::pin!(operation);
        let mut progress_open = true;
        let result = loop {
            tokio::select! {
                result = &mut operation => break result,
                progress = progress.recv(), if progress_open => {
                    match progress {
                        Some(progress) => {
                            if !send_progress(&events, progress).await {
                                cancellation.cancel();
                            }
                        }
                        None => progress_open = false,
                    }
                }
            }
        };
        match result {
            Ok(file) => {
                let (download_id, size, name) = service.transfers().create_download(file);
                let delivered = send_event(
                    &events,
                    json_value!({ "type": "done", "downloadId": download_id.clone(), "size": size, "name": name }),
                )
                .await;
                if !delivered {
                    service.transfers().remove_download(&download_id);
                }
            }
            Err(error) => {
                let _ = send_file_error_event(&events, error).await;
            }
        }
    });
    ndjson_response(receiver, move || stream_cancellation.cancel())
}

async fn handle_download_content(handler: &HttpHandler, id: &str) -> FilesHandlerResult {
    let Some(session) = handler.files.transfers().take_download(id) else {
        return Ok(code_error(FileError::code(FileErrorCode::NotFound)));
    };
    stream_download_session(session).await
}

async fn handle_upload_init(handler: &HttpHandler, request: Request<Body>) -> FilesHandlerResult {
    let body = collect_object(request.into_body()).await?;
    let root_id = body
        .get("rootId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let destination = body
        .get("path")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let raw_name = body
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let Some(size) = body.get("size").and_then(json_u64) else {
        return Ok(invalid_request(handler));
    };
    let kind = body
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or("file");
    if !matches!(kind, "file" | "paste-image") {
        return Ok(invalid_request(handler));
    }
    if root_id.is_empty() || destination.is_empty() || raw_name.is_empty() {
        return Ok(invalid_request(handler));
    }
    let Some(name) = crate::files::sanitize_upload_name(raw_name) else {
        return Ok(code_error(FileError::code(FileErrorCode::Invalid)));
    };
    if let Err(error) = validate_upload_size(kind, size, handler.config.transfer_max_bytes) {
        return Ok(code_error(error));
    }
    match handler.files.stat_file(root_id, destination).await {
        Ok(stat) if stat.entry_type == crate::files::FileEntryType::Dir => {}
        Ok(_) => return Ok(code_error(FileError::code(FileErrorCode::NotADirectory))),

        Err(error) => return Ok(code_error(error)),
    }
    let id = handler
        .files
        .transfers()
        .create_upload(root_id.to_owned(), destination.to_owned(), name, size)
        .await
        .map_err(FilesHandlerError::File)?;
    Ok(json(
        StatusCode::OK,
        &json_value!({ "uploadId": id, "chunkSize": UPLOAD_CHUNK_SIZE }),
    ))
}

fn validate_upload_size(kind: &str, size: u64, transfer_max_bytes: f64) -> Result<(), FileError> {
    if size as f64 > transfer_max_bytes {
        return Err(FileError::code(FileErrorCode::TooLarge));
    }
    if kind == "paste-image" && size > PASTE_IMAGE_MAX_BYTES {
        return Err(FileError::detailed(
            FileErrorCode::TooLarge,
            "paste image exceeds the 4 MiB limit",
        ));
    }
    Ok(())
}

async fn handle_upload_chunk(
    handler: &HttpHandler,
    request: Request<Body>,
    id: &str,
) -> FilesHandlerResult {
    let Some(offset) =
        query_parameter(request.uri(), "offset").and_then(|value| parse_offset(&value))
    else {
        return Ok(invalid_request(handler));
    };
    let bytes = match to_bytes(request.into_body(), UPLOAD_CHUNK_BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(code_error(FileError::code(FileErrorCode::TooLarge))),
    };
    match handler
        .files
        .transfers()
        .append_upload(id, offset, &bytes)
        .await
    {
        Ok(received) => Ok(json(StatusCode::OK, &json_value!({ "received": received }))),
        Err(AppendUploadError::NotFound) => {
            Ok(code_error(FileError::code(FileErrorCode::NotFound)))
        }
        Err(AppendUploadError::TooLarge) => {
            Ok(code_error(FileError::code(FileErrorCode::TooLarge)))
        }
        Err(AppendUploadError::BadOffset | AppendUploadError::Committing) => Ok(error_json(
            StatusCode::CONFLICT,
            &handler.translate("apiError.invalidRequest"),
        )),
        Err(AppendUploadError::Io) => Ok(code_error(FileError::code(FileErrorCode::Unknown))),
    }
}

async fn handle_upload_commit(handler: &HttpHandler, id: String) -> FilesHandlerResult {
    let commit = match handler.files.transfers().begin_upload_commit(&id).await {
        Ok(commit) => commit,
        Err(error) => return Ok(code_error(error)),
    };
    let service = handler.files.clone();
    let manager = handler.files.transfers().clone();
    let cleanup = UploadCleanup::new(manager, id, commit.cancellation.clone());
    let stream_cleanup = cleanup.clone();
    let (events, receiver) = mpsc::channel(STREAM_BUFFER);
    let progress_events = events.clone();
    let operation = async move {
        let (progress_sender, mut progress) = mpsc::channel(STREAM_BUFFER);
        let operation = service.push_file(
            &commit.root_id,
            &commit.destination_directory,
            &commit.path,
            &commit.name,
            commit.cancellation.clone(),
            Some(progress_sender),
        );
        tokio::pin!(operation);
        let mut progress_open = true;
        let result = loop {
            tokio::select! {
                result = &mut operation => break result,
                progress = progress.recv(), if progress_open => {
                    match progress {
                        Some(progress) => {
                            if !send_progress(&progress_events, progress).await {
                                commit.cancellation.cancel();
                            }
                        }
                        None => progress_open = false,
                    }
                }
            }
        };
        result
    };
    tokio::spawn(run_upload_producer(events, cleanup, operation));
    Ok(ndjson_response(receiver, move || stream_cleanup.cleanup()))
}

async fn run_upload_producer<F>(events: mpsc::Sender<Bytes>, cleanup: UploadCleanup, operation: F)
where
    F: Future<Output = Result<String, FileError>> + Send,
{
    let _cleanup_guard = UploadCleanupGuard::new(cleanup.clone());
    let outcome = AssertUnwindSafe(operation).catch_unwind().await;
    cleanup.cleanup();
    match outcome {
        Ok(Ok(uploaded)) => {
            let _ = send_event(
                &events,
                json_value!({ "type": "done", "uploaded": uploaded }),
            )
            .await;
        }
        Ok(Err(error)) => {
            let _ = send_file_error_event(&events, error).await;
        }
        Err(_) => {
            let _ = send_event(
                &events,
                json_value!({ "type": "error", "code": FileErrorCode::Unknown.as_str() }),
            )
            .await;
        }
    }
}

async fn stream_download_session(session: DownloadSession) -> FilesHandlerResult {
    let size = session.size;
    let name = session.name.clone();
    let mime = session.mime;
    stream_file_response(session.file, true, true)
        .await
        .map(|mut response| {
            apply_attachment_headers(&mut response, &name, mime, size);
            response
        })
}

async fn stream_file_response(
    file: PulledFile,
    attachment: bool,
    no_store: bool,
) -> FilesHandlerResult {
    let opened = tokio::fs::File::open(&file.path).await.map_err(|error| {
        FilesHandlerError::File(FileError::detailed(
            FileErrorCode::Unknown,
            error.to_string(),
        ))
    })?;
    let name = file.name.clone();
    let mime = file.mime;
    let size = file.size;
    let stream = stream::try_unfold(
        FileStreamState {
            file: opened,
            _temporary: file,
        },
        |mut state| async move {
            let mut buffer = vec![0_u8; FILE_READ_BUFFER];
            match state.file.read(&mut buffer).await {
                Ok(0) => Ok::<_, std::io::Error>(None),
                Ok(read) => {
                    buffer.truncate(read);
                    Ok(Some((Bytes::from(buffer), state)))
                }
                Err(error) => Err(error),
            }
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static(mime.unwrap_or("application/octet-stream")),
    );
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    if attachment {
        insert_content_disposition(&mut response, &name);
    }
    if no_store {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    Ok(response)
}

struct FileStreamState {
    file: tokio::fs::File,
    _temporary: PulledFile,
}

fn ndjson_response(
    receiver: mpsc::Receiver<Bytes>,
    on_drop: impl FnOnce() + Send + Sync + 'static,
) -> HttpResponse {
    let stream = stream::unfold(
        ChannelStreamState {
            receiver,
            on_drop: Some(Box::new(on_drop)),
        },
        |mut state| async move {
            match state.receiver.recv().await {
                Some(bytes) => Some((Ok::<_, Infallible>(bytes), state)),
                None => {
                    if let Some(on_drop) = state.on_drop.take() {
                        on_drop();
                    }
                    None
                }
            }
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

struct ChannelStreamState {
    receiver: mpsc::Receiver<Bytes>,
    on_drop: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl Drop for ChannelStreamState {
    fn drop(&mut self) {
        if let Some(on_drop) = self.on_drop.take() {
            on_drop();
        }
    }
}

#[derive(Clone)]
struct UploadCleanup {
    manager: TransferManager,
    id: String,
    cancellation: FileCancellation,
    cleaned: Arc<AtomicBool>,
}

impl UploadCleanup {
    fn new(manager: TransferManager, id: String, cancellation: FileCancellation) -> Self {
        Self {
            manager,
            id,
            cancellation,
            cleaned: Arc::new(AtomicBool::new(false)),
        }
    }

    fn cleanup(&self) {
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return;
        }
        self.cancellation.cancel();
        self.manager.remove_upload(&self.id);
    }
}

struct UploadCleanupGuard(UploadCleanup);

impl UploadCleanupGuard {
    fn new(cleanup: UploadCleanup) -> Self {
        Self(cleanup)
    }
}

impl Drop for UploadCleanupGuard {
    fn drop(&mut self) {
        self.0.cleanup();
    }
}

struct CancelOnDrop {
    cancellation: FileCancellation,
    armed: bool,
}

impl CancelOnDrop {
    fn new(cancellation: FileCancellation) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

async fn send_progress(events: &mpsc::Sender<Bytes>, progress: RsyncProgress) -> bool {
    send_event(
        events,
        json_value!({
            "type": "progress",
            "transferred": progress.transferred,
            "pct": progress.pct,
            "rate": progress.rate,
        }),
    )
    .await
}

async fn send_file_error_event(events: &mpsc::Sender<Bytes>, error: FileError) -> bool {
    send_event(
        events,
        json_value!({
            "type": "error",
            "code": error.code.as_str(),
            "detail": error.detail,
        }),
    )
    .await
}

async fn send_event(events: &mpsc::Sender<Bytes>, event: JsonValue) -> bool {
    let mut bytes = match serde_json::to_vec(&event) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    bytes.push(b'\n');
    events.send(Bytes::from(bytes)).await.is_ok()
}

async fn collect_object(body: Body) -> Result<JsonMap<String, JsonValue>, FilesHandlerError> {
    let bytes = to_bytes(body, JSON_BODY_LIMIT)
        .await
        .map_err(|_| FilesHandlerError::InvalidBody)?;
    match serde_json::from_slice(&bytes) {
        Ok(JsonValue::Object(body)) => Ok(body),
        _ => Err(FilesHandlerError::InvalidBody),
    }
}

fn code_error(error: FileError) -> HttpResponse {
    #[derive(Serialize)]
    struct ErrorEnvelope<'a> {
        error: &'a str,
        code: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<&'a str>,
    }
    let status = match error.code {
        FileErrorCode::Invalid | FileErrorCode::NotADirectory | FileErrorCode::AuthUnsupported => {
            StatusCode::BAD_REQUEST
        }
        FileErrorCode::OutsideRoots
        | FileErrorCode::PermissionDenied
        | FileErrorCode::RootDisabled => StatusCode::FORBIDDEN,
        FileErrorCode::NotFound | FileErrorCode::DeviceNotFound | FileErrorCode::RootNotFound => {
            StatusCode::NOT_FOUND
        }
        FileErrorCode::IsDirectory => StatusCode::BAD_REQUEST,
        FileErrorCode::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        FileErrorCode::Binary => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        FileErrorCode::ConnectionFailed
        | FileErrorCode::RsyncMissingLocal
        | FileErrorCode::RsyncMissingRemote => StatusCode::BAD_GATEWAY,
        FileErrorCode::Timeout => StatusCode::GATEWAY_TIMEOUT,
        FileErrorCode::Unknown => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let code = error.code.as_str();
    json(
        status,
        &ErrorEnvelope {
            error: code,
            code,
            detail: error.detail.as_deref(),
        },
    )
}

fn invalid_request(handler: &HttpHandler) -> HttpResponse {
    error_json(
        StatusCode::BAD_REQUEST,
        &handler.translate("apiError.invalidRequest"),
    )
}

fn files_handler_error(handler: &HttpHandler, error: FilesHandlerError) -> HttpResponse {
    match error {
        FilesHandlerError::Repository(error) => HandlerError::Repository(error).into_response(),
        FilesHandlerError::Runtime(error) => HandlerError::Runtime(error).into_response(),
        FilesHandlerError::File(error) => code_error(error),
        FilesHandlerError::InvalidBody => invalid_request(handler),
    }
}

type FilesHandlerResult = Result<HttpResponse, FilesHandlerError>;

#[derive(Debug, thiserror::Error)]
enum FilesHandlerError {
    #[error(transparent)]
    Repository(#[from] RepositoryError),
    #[error(transparent)]
    Runtime(#[from] super::runtime::HttpRuntimeError),
    #[error(transparent)]
    File(#[from] FileError),
    #[error("invalid request body")]
    InvalidBody,
}

fn root_display_name(path: &str) -> String {
    if path == "/" {
        "/".to_owned()
    } else {
        let trimmed = path.trim_end_matches('/');
        trimmed
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(path)
            .to_owned()
    }
}

fn decode_component(value: &str) -> Result<String, FileError> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| FileError::code(FileErrorCode::Invalid))
}

fn query_parameter(uri: &Uri, name: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(key)?;
        (key == name)
            .then(|| decode_query_component(value))
            .flatten()
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    percent_decode_str(&value.replace('+', " "))
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn json_u64(value: &JsonValue) -> Option<u64> {
    value.as_u64().or_else(|| {
        let number = value.as_f64()?;
        (number.is_finite() && number >= 0.0 && number.fract() == 0.0 && number <= u64::MAX as f64)
            .then_some(number as u64)
    })
}

fn parse_offset(value: &str) -> Option<u64> {
    let value = value.trim_start();
    if value.starts_with('-') {
        return None;
    }
    let value = value.strip_prefix('+').unwrap_or(value);
    let digits = value
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    (digits > 0).then(|| value[..digits].parse().ok()).flatten()
}

fn apply_attachment_headers(
    response: &mut HttpResponse,
    name: &str,
    mime: Option<&'static str>,
    size: u64,
) {
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static(mime.unwrap_or("application/octet-stream")),
    );
    if let Ok(length) = HeaderValue::from_str(&size.to_string()) {
        response.headers_mut().insert(CONTENT_LENGTH, length);
    }
    insert_content_disposition(response, name);
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

fn insert_content_disposition(response: &mut HttpResponse, name: &str) {
    let encoded = utf8_percent_encode(name, FILE_NAME_ENCODE_SET);
    let ascii = name
        .chars()
        .map(|character| {
            if matches!(character, '"' | '\\' | '\r' | '\n') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let value = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}");
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().insert(CONTENT_DISPOSITION, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::PulledFile;

    #[tokio::test]
    async fn dropping_file_body_releases_the_temporary_artifact() {
        let directory = tempfile::Builder::new()
            .prefix("tmex-dl-")
            .tempdir()
            .expect("temporary directory");
        let path = directory.path().join("f");
        tokio::fs::write(&path, b"streamed")
            .await
            .expect("write stream file");
        let file = PulledFile::from_parts(
            path.clone(),
            8,
            "stream.txt".to_owned(),
            Some("text/plain; charset=utf-8"),
            directory,
        );
        let response = stream_file_response(file, true, true)
            .await
            .expect("stream response");
        drop(response);
        tokio::task::yield_now().await;
        assert!(
            !path.exists(),
            "dropping Body must clean its temporary file"
        );
    }

    #[tokio::test]
    async fn dropping_ndjson_body_cancels_and_removes_upload_session() {
        let manager = crate::files::TransferManager::new();
        let id = manager
            .create_upload(
                "root".to_owned(),
                "/destination".to_owned(),
                "file".to_owned(),
                0,
            )
            .await
            .expect("create upload");
        let commit = manager
            .begin_upload_commit(&id)
            .await
            .expect("begin commit");
        let cancellation = commit.cancellation.clone();
        let (_sender, receiver) = mpsc::channel(1);
        let cleanup_manager = manager.clone();
        let cleanup_id = id.clone();
        let response = ndjson_response(receiver, move || {
            cleanup_manager.remove_upload(&cleanup_id);
        });

        drop(response);
        tokio::task::yield_now().await;

        assert!(cancellation.is_cancelled());
        let error = match manager.begin_upload_commit(&id).await {
            Ok(_) => panic!("dropped stream must remove the session"),
            Err(error) => error,
        };
        assert_eq!(error.code, FileErrorCode::NotFound);
    }

    #[tokio::test]
    async fn closed_ndjson_channel_cleans_a_committing_upload() {
        let manager = crate::files::TransferManager::new();
        let id = manager
            .create_upload(
                "root".to_owned(),
                "/destination".to_owned(),
                "file".to_owned(),
                0,
            )
            .await
            .expect("create upload");
        let commit = manager
            .begin_upload_commit(&id)
            .await
            .expect("begin commit");
        let path = commit.path.clone();
        let cancellation = commit.cancellation.clone();
        let cleanup = UploadCleanup::new(manager.clone(), id.clone(), cancellation.clone());
        let response_cleanup = cleanup.clone();
        let (sender, receiver) = mpsc::channel(1);
        let response = ndjson_response(receiver, move || response_cleanup.cleanup());
        drop(commit);
        drop(sender);

        let body = to_bytes(response.into_body(), 1024)
            .await
            .expect("consume closed NDJSON stream");

        assert!(body.is_empty());
        assert!(cancellation.is_cancelled());
        assert!(!path.exists());
        assert!(manager.begin_upload_commit(&id).await.is_err());
    }

    #[tokio::test]
    async fn upload_producer_panic_is_redacted_and_cleans_the_session() {
        const SENSITIVE_PANIC_PAYLOAD: &str = "sensitive-upload-payload";

        let manager = crate::files::TransferManager::new();
        let id = manager
            .create_upload(
                "root".to_owned(),
                "/destination".to_owned(),
                "file".to_owned(),
                0,
            )
            .await
            .expect("create upload");
        let commit = manager
            .begin_upload_commit(&id)
            .await
            .expect("begin commit");
        let path = commit.path.clone();
        let cancellation = commit.cancellation.clone();
        let cleanup = UploadCleanup::new(manager.clone(), id.clone(), cancellation.clone());
        let (events, mut receiver) = mpsc::channel(1);

        run_upload_producer(events, cleanup.clone(), async move {
            let _commit = commit;
            if std::hint::black_box(true) {
                std::panic::panic_any(SENSITIVE_PANIC_PAYLOAD);
            }
            Ok::<String, FileError>(String::new())
        })
        .await;

        let event = receiver.recv().await.expect("panic error event");
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&event).expect("decode panic event"),
            json_value!({ "type": "error", "code": "unknown" })
        );
        assert!(!String::from_utf8_lossy(&event).contains(SENSITIVE_PANIC_PAYLOAD));
        cleanup.cleanup();
        assert!(cancellation.is_cancelled());
        assert!(!path.exists());
        assert!(manager.begin_upload_commit(&id).await.is_err());
    }

    #[test]
    fn paste_image_size_limit_is_stricter_than_regular_file_uploads() {
        let transfer_limit = (2_u64 * 1024 * 1024 * 1024) as f64;
        assert!(validate_upload_size("paste-image", PASTE_IMAGE_MAX_BYTES, transfer_limit).is_ok());
        let error =
            validate_upload_size("paste-image", PASTE_IMAGE_MAX_BYTES + 1, transfer_limit)
                .expect_err("paste image over 4 MiB must be rejected");
        assert_eq!(error.code, FileErrorCode::TooLarge);
        assert_eq!(
            error.detail.as_deref(),
            Some("paste image exceeds the 4 MiB limit")
        );
        assert!(
            validate_upload_size("file", PASTE_IMAGE_MAX_BYTES + 1, transfer_limit).is_ok(),
            "regular file uploads keep the configured transfer limit"
        );
    }
}
