use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, HeaderValue, Request, header},
    middleware::Next,
    response::Response,
};
use axum_extra::extract::cookie::CookieJar;
use url::Url;

use crate::{
    auth::session::{SESSION_COOKIE, hash_session_token},
    db,
    error::AppError,
    models::User,
    state::AppState,
};

pub struct AuthUser {
    pub user: User,
    pub session_token_hash: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .map(|cookie| cookie.value())
            .filter(|token| !token.is_empty())
            .ok_or(AppError::Unauthorized)?;

        let token_hash = hash_session_token(token);
        let user = db::find_user_by_session_token_hash(&state.pool, &token_hash)
            .await?
            .ok_or(AppError::Unauthorized)?;

        Ok(Self {
            user,
            session_token_hash: token_hash,
        })
    }
}

/// Prevents browsers and intermediary caches from storing auth responses.
pub async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    response
}

/// Validates the request origin for cookie-authenticated mutations.
///
/// Browsers send `Origin` on POST requests. `Referer` is accepted as a
/// fallback for older clients, but only its origin is compared.
pub fn verify_csrf_origin(headers: &HeaderMap, expected_origin: &str) -> Result<(), AppError> {
    let origin = match headers.get(header::ORIGIN) {
        Some(value) => value.to_str().ok().map(str::to_owned),
        None => headers
            .get(header::REFERER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Url::parse(value).ok())
            .map(|url| url.origin().ascii_serialization()),
    };

    match origin {
        Some(origin) if origin == expected_origin => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csrf_origin_must_match_exactly() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://localhost:5173".parse().unwrap());

        assert!(verify_csrf_origin(&headers, "http://localhost:5173").is_ok());
        assert!(verify_csrf_origin(&headers, "http://evil.example").is_err());
    }

    #[test]
    fn csrf_rejects_missing_origin() {
        assert!(verify_csrf_origin(&HeaderMap::new(), "http://localhost:5173").is_err());
    }

    #[test]
    fn csrf_falls_back_to_referer_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::REFERER,
            "http://localhost:5173/dashboard?tab=reviews"
                .parse()
                .unwrap(),
        );

        assert!(verify_csrf_origin(&headers, "http://localhost:5173").is_ok());
    }
}
