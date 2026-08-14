use axum::body::Body;
use bytes::Bytes;
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use http::{HeaderValue, Response, StatusCode};
use serde::Serialize;

use crate::crypto::CryptoError;
use crate::database::repository::RepositoryError;
use crate::watch::WatchServiceError;

use super::runtime::{HttpRuntimeError, HttpRuntimeErrorKind};

pub type HttpResponse = Response<Body>;
pub type HandlerResult = Result<HttpResponse, HandlerError>;

#[derive(Debug, thiserror::Error)]
pub enum HandlerError {
    #[error(transparent)]
    Repository(#[from] RepositoryError),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error(transparent)]
    Runtime(#[from] HttpRuntimeError),
    #[error(transparent)]
    Watch(#[from] WatchServiceError),
    #[error("{0}")]
    InvalidRequest(String),
}

impl HandlerError {
    pub fn into_response(self) -> HttpResponse {
        match self {
            Self::InvalidRequest(message) => error_json(StatusCode::BAD_REQUEST, &message),
            Self::Runtime(error) => {
                let status = match error.kind {
                    HttpRuntimeErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
                    HttpRuntimeErrorKind::BadGateway => StatusCode::BAD_GATEWAY,
                    HttpRuntimeErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
                };
                error_json(status, &error.message)
            }
            Self::Repository(_) => error_json(StatusCode::INTERNAL_SERVER_ERROR, "database error"),
            Self::Crypto(_) => error_json(StatusCode::INTERNAL_SERVER_ERROR, "encryption failed"),
            Self::Watch(_) => error_json(StatusCode::INTERNAL_SERVER_ERROR, "watch service error"),
        }
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

pub fn error_json(status: StatusCode, message: &str) -> HttpResponse {
    json(status, &ErrorBody { error: message })
}

pub fn json<T: Serialize>(status: StatusCode, value: &T) -> HttpResponse {
    let body = match serde_json::to_vec(value) {
        Ok(body) => Bytes::from(body),
        Err(_) => Bytes::from_static(br#"{"error":"response serialization failed"}"#),
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

pub fn manifest<T: Serialize>(value: &T, head: bool) -> HttpResponse {
    let body = if head {
        Bytes::new()
    } else {
        match serde_json::to_vec(value) {
            Ok(body) => Bytes::from(body),
            Err(_) => Bytes::from_static(br#"{"error":"response serialization failed"}"#),
        }
    };
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
