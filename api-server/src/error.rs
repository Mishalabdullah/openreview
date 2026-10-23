use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("database operation failed")]
    Database(#[from] sqlx::Error),

    #[error("database migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("internal error: {0}")]
    Internal(&'static str),

    #[error("bad request: {0}")]
    BadRequest(&'static str),

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("github authentication failed")]
    GitHubUnauthorized,

    #[error("github is unavailable")]
    GitHubUpstream,

    #[error("github reauthentication is required")]
    ReauthRequired,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            Self::Config(_) | Self::Database(_) | Self::Migration(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            }
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, *message),
            Self::Unauthorized | Self::ReauthRequired | Self::GitHubUnauthorized => {
                (StatusCode::UNAUTHORIZED, "unauthorized")
            }
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::GitHubUpstream => (StatusCode::BAD_GATEWAY, "github_unavailable"),
        };

        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        } else if status == StatusCode::BAD_GATEWAY {
            tracing::warn!(error = %self, "upstream request failed");
        }

        (status, Json(json!({ "error": message }))).into_response()
    }
}
