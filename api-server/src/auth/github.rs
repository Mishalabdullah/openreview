use std::time::Duration as StdDuration;

use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;
use uuid::Uuid;

use crate::{
    auth::{
        middleware::{AuthUser, verify_csrf_origin},
        session::{
            OAUTH_COOKIE, OAUTH_STATE_TTL_SECONDS, clear_oauth_cookie, clear_session_cookie,
            generate_random_token, generate_session_token, hash_session_token, oauth_cookie,
            session_cookie, session_ttl,
        },
    },
    config::{Config, Secret},
    crypto::CryptoError,
    db::{self, GithubTokens},
    error::AppError,
    models::{GithubUser, MeResponse, User},
    state::AppState,
};

const GITHUB_OAUTH_BASE: &str = "https://github.com";
const GITHUB_API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "OpenReview/0.1 (+https://github.com/Mishalabdullah/openreview)";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_API_VERSION: &str = "2022-11-28";

#[derive(Clone)]
pub struct GithubClient {
    http: reqwest::Client,
    client_id: String,
    client_secret: Secret,
    redirect_uri: String,
    oauth_base: Url,
    api_base: Url,
}

#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    #[error("github request failed: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("github returned status {status}")]
    Status { status: StatusCode },

    #[error("github oauth error: {code}")]
    OAuth { code: String },

    #[error("invalid github response")]
    InvalidResponse,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccessTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub refresh_token_expires_in: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct OAuthStatePayload {
    pub state: String,
    pub code_verifier: String,
    pub created_at: i64,
}

impl GithubClient {
    pub fn new(config: &Config) -> Result<Self, AppError> {
        Self::build(
            config,
            Url::parse(GITHUB_OAUTH_BASE).expect("static GitHub OAuth URL is valid"),
            Url::parse(GITHUB_API_BASE).expect("static GitHub API URL is valid"),
        )
    }

    fn build(config: &Config, oauth_base: Url, api_base: Url) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .connect_timeout(StdDuration::from_secs(5))
            .timeout(StdDuration::from_secs(10))
            .build()
            .map_err(|_| AppError::Internal("failed to build GitHub HTTP client"))?;

        Ok(Self {
            http,
            client_id: config.github_client_id.clone(),
            client_secret: config.github_client_secret.clone(),
            redirect_uri: config.github_callback_url.to_string(),
            oauth_base,
            api_base,
        })
    }

    #[cfg(test)]
    pub fn for_test(config: &Config, oauth_base: Url, api_base: Url) -> Self {
        Self::build(config, oauth_base, api_base).expect("test GitHub client should build")
    }

    pub fn authorize_url(&self, state: &str, code_challenge: &str) -> Result<Url, AppError> {
        let mut url = self
            .oauth_base
            .join("/login/oauth/authorize")
            .map_err(|_| AppError::Internal("failed to build GitHub authorization URL"))?;

        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256");

        Ok(url)
    }

    pub async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
    ) -> Result<AccessTokenResponse, GithubError> {
        self.request_token(&[
            ("client_id", &self.client_id),
            ("client_secret", self.client_secret.expose()),
            ("code", code),
            ("redirect_uri", &self.redirect_uri),
            ("code_verifier", code_verifier),
        ])
        .await
    }

    pub async fn refresh_token(
        &self,
        refresh_token: &str,
    ) -> Result<AccessTokenResponse, GithubError> {
        self.request_token(&[
            ("client_id", &self.client_id),
            ("client_secret", self.client_secret.expose()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .await
    }

    async fn request_token(
        &self,
        params: &[(&str, &str)],
    ) -> Result<AccessTokenResponse, GithubError> {
        let url = self
            .oauth_base
            .join("/login/oauth/access_token")
            .map_err(|_| GithubError::InvalidResponse)?;

        let response = self
            .http
            .post(url)
            .header(header::ACCEPT, header::HeaderValue::from_static("application/json"))
            .header(header::USER_AGENT, USER_AGENT)
            .form(params)
            .send()
            .await?;

        parse_token_response(response).await
    }

    pub async fn fetch_user(&self, access_token: &str) -> Result<GithubUser, GithubError> {
        let url = self
            .api_base
            .join("/user")
            .map_err(|_| GithubError::InvalidResponse)?;

        let response = self
            .http
            .get(url)
            .header(header::ACCEPT, GITHUB_ACCEPT)
            .header(header::USER_AGENT, USER_AGENT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(GithubError::Status { status });
        }

        response
            .json::<GithubUser>()
            .await
            .map_err(|_| GithubError::InvalidResponse)
    }
}

async fn parse_token_response(
    response: reqwest::Response,
) -> Result<AccessTokenResponse, GithubError> {
    let status = response.status();
    let body = response.text().await?;

    let token = match serde_json::from_str::<AccessTokenResponse>(&body) {
        Ok(token) => token,
        Err(_) if !status.is_success() => return Err(GithubError::Status { status }),
        Err(_) => return Err(GithubError::InvalidResponse),
    };

    if let Some(code) = token.error.clone() {
        return Err(GithubError::OAuth { code });
    }

    if !status.is_success() {
        return Err(GithubError::Status { status });
    }

    if token.access_token.is_none() {
        return Err(GithubError::InvalidResponse);
    }

    Ok(token)
}

impl From<GithubError> for AppError {
    fn from(error: GithubError) -> Self {
        tracing::warn!(error = %error, "github request failed");

        match error {
            GithubError::Status { status } if status == StatusCode::UNAUTHORIZED => {
                AppError::GitHubUnauthorized
            }
            GithubError::OAuth { code }
                if code == "bad_verification_code" || code == "access_denied" =>
            {
                AppError::BadRequest("github_authorization_failed")
            }
            _ => AppError::GitHubUpstream,
        }
    }
}

pub fn generate_pkce() -> Result<(String, String), CryptoError> {
    let verifier = generate_random_token(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    Ok((verifier, challenge))
}

pub fn generate_oauth_state() -> Result<String, CryptoError> {
    generate_random_token(32)
}

pub fn oauth_state_is_valid(
    payload: &OAuthStatePayload,
    returned_state: &str,
    now: chrono::DateTime<Utc>,
) -> bool {
    let state_matches: bool = payload
        .state
        .as_bytes()
        .ct_eq(returned_state.as_bytes())
        .into();

    let not_from_future = payload.created_at <= now.timestamp() + 60;
    let not_expired =
        now.timestamp().saturating_sub(payload.created_at) <= OAUTH_STATE_TTL_SECONDS;

    state_matches && not_from_future && not_expired
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Redirect), AppError> {
    let oauth_state = generate_oauth_state()?;
    let (code_verifier, code_challenge) = generate_pkce()?;

    let payload = OAuthStatePayload {
        state: oauth_state.clone(),
        code_verifier,
        created_at: Utc::now().timestamp(),
    };
    let serialized = serde_json::to_string(&payload)
        .map_err(|_| AppError::Internal("failed to encode OAuth state"))?;
    let encrypted = state
        .crypto
        .encrypt_oauth_state(&serialized)
        .map_err(|_| AppError::Internal("failed to encrypt OAuth state"))?;

    let authorize_url = state
        .github
        .authorize_url(&oauth_state, &code_challenge)?;

    tracing::debug!("starting github oauth flow");

    Ok((
        jar.add(oauth_cookie(encrypted, &state.config)),
        Redirect::to(authorize_url.as_str()),
    ))
}

pub async fn callback(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
    jar: CookieJar,
) -> Response {
    let stored_state = jar
        .get(OAUTH_COOKIE)
        .map(|cookie| cookie.value().to_owned());

    // The verifier is single-use: remove it from the browser on every callback.
    let jar = jar.remove(clear_oauth_cookie(&state.config));

    match complete_callback(&state, query, stored_state.as_deref()).await {
        Ok((_user, session_token)) => {
            let cookie = session_cookie(session_token, &state.config);
            let dashboard_url = format!(
                "{}/dashboard",
                state.config.frontend_url.as_str().trim_end_matches('/')
            );

            (jar.add(cookie), Redirect::to(&dashboard_url)).into_response()
        }
        Err(error) => (jar, error.into_response()).into_response(),
    }
}

async fn complete_callback(
    state: &AppState,
    query: CallbackQuery,
    stored_state: Option<&str>,
) -> Result<(User, String), AppError> {
    if query.error.is_some() {
        return Err(AppError::BadRequest("github_authorization_denied"));
    }

    let code = query
        .code
        .filter(|code| !code.is_empty())
        .ok_or(AppError::BadRequest("missing_authorization_code"))?;
    let returned_state = query
        .state
        .filter(|state| !state.is_empty())
        .ok_or(AppError::BadRequest("missing_oauth_state"))?;
    let stored_state = stored_state.ok_or(AppError::BadRequest("invalid_oauth_state"))?;

    let decrypted = state
        .crypto
        .decrypt_oauth_state(stored_state)
        .map_err(|_| AppError::BadRequest("invalid_oauth_state"))?;
    let payload: OAuthStatePayload = serde_json::from_str(&decrypted)
        .map_err(|_| AppError::BadRequest("invalid_oauth_state"))?;

    if !oauth_state_is_valid(&payload, &returned_state, Utc::now()) {
        return Err(AppError::BadRequest("invalid_oauth_state"));
    }

    let tokens = state
        .github
        .exchange_code(&code, &payload.code_verifier)
        .await?;
    let access_token = tokens
        .access_token
        .clone()
        .ok_or(AppError::GitHubUpstream)?;
    let github_user = state.github.fetch_user(&access_token).await?;

    let now = Utc::now();
    let access_token_encrypted = state
        .crypto
        .encrypt_github_token(&access_token)
        .map_err(|_| AppError::Internal("failed to encrypt GitHub access token"))?;
    let refresh_token_encrypted = match tokens.refresh_token.as_deref() {
        Some(token) => Some(
            state
                .crypto
                .encrypt_github_token(token)
                .map_err(|_| AppError::Internal("failed to encrypt GitHub refresh token"))?,
        ),
        None => None,
    };

    let connection_tokens = GithubTokens {
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at: tokens
            .expires_in
            .map(|seconds| now + TimeDelta::seconds(seconds)),
        refresh_token_expires_at: tokens
            .refresh_token_expires_in
            .map(|seconds| now + TimeDelta::seconds(seconds)),
    };

    let session_token = generate_session_token()?;
    let session_token_hash = hash_session_token(&session_token);
    let session_expires_at = now + session_ttl();

    let user = db::create_login(
        &state.pool,
        &github_user,
        &connection_tokens,
        &session_token_hash,
        session_expires_at,
    )
    .await?;

    tracing::info!(user_id = %user.id, "github login completed");

    Ok((user, session_token))
}

pub async fn me(user: AuthUser) -> Json<MeResponse> {
    Json(user.user.into())
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: AuthUser,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    verify_csrf_origin(&headers, &state.config.frontend_origin)?;

    db::revoke_session(&state.pool, &user.session_token_hash).await?;
    tracing::info!(user_id = %user.user.id, "session revoked");

    Ok((
        jar.add(clear_session_cookie(&state.config)),
        StatusCode::NO_CONTENT,
    ))
}

/// Returns a valid GitHub access token, refreshing and rotating it when needed.
///
/// Kept crate-visible for the upcoming GitHub repository/PR integrations. The
/// refresh path is covered by integration tests.
#[allow(dead_code)]
pub async fn valid_github_access_token(
    state: &AppState,
    user_id: Uuid,
) -> Result<String, AppError> {
    let now = Utc::now();
    let mut tx = state.pool.begin().await?;
    let connection = db::load_connection_for_update(&mut tx, user_id)
        .await?
        .ok_or(AppError::ReauthRequired)?;

    let access_is_valid = connection
        .token_expires_at
        .is_none_or(|expires_at| expires_at > now + TimeDelta::seconds(60));

    if access_is_valid {
        let access_token = state
            .crypto
            .decrypt_github_token(&connection.access_token_encrypted)
            .map_err(|_| AppError::Internal("failed to decrypt GitHub access token"))?;
        tx.commit().await?;
        return Ok(access_token);
    }

    let Some(refresh_token_encrypted) = connection.refresh_token_encrypted.as_deref() else {
        db::delete_connection(&mut tx, user_id).await?;
        tx.commit().await?;
        return Err(AppError::ReauthRequired);
    };

    if connection
        .refresh_token_expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        db::delete_connection(&mut tx, user_id).await?;
        tx.commit().await?;
        return Err(AppError::ReauthRequired);
    }

    let refresh_token = state
        .crypto
        .decrypt_github_token(refresh_token_encrypted)
        .map_err(|_| AppError::Internal("failed to decrypt GitHub refresh token"))?;

    let refreshed = match state.github.refresh_token(&refresh_token).await {
        Ok(tokens) => tokens,
        Err(GithubError::OAuth { code }) if code == "bad_refresh_token" => {
            // The credential was revoked or has already been rotated elsewhere.
            db::delete_connection(&mut tx, user_id).await?;
            tx.commit().await?;
            tracing::info!(%user_id, "revoked github connection");
            return Err(AppError::ReauthRequired);
        }
        Err(error) => return Err(error.into()),
    };

    let access_token = refreshed
        .access_token
        .clone()
        .ok_or(AppError::GitHubUpstream)?;
    let access_token_encrypted = state
        .crypto
        .encrypt_github_token(&access_token)
        .map_err(|_| AppError::Internal("failed to encrypt GitHub access token"))?;
    let refresh_token_encrypted = match refreshed.refresh_token.as_deref() {
        Some(token) => Some(
            state
                .crypto
                .encrypt_github_token(token)
                .map_err(|_| AppError::Internal("failed to encrypt GitHub refresh token"))?,
        ),
        None => connection.refresh_token_encrypted.clone(),
    };

    let tokens = GithubTokens {
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at: refreshed
            .expires_in
            .map(|seconds| now + TimeDelta::seconds(seconds)),
        refresh_token_expires_at: refreshed
            .refresh_token_expires_in
            .map(|seconds| now + TimeDelta::seconds(seconds)),
    };

    db::update_connection_tokens(&mut tx, connection.id, &tokens).await?;
    tx.commit().await?;

    tracing::info!(%user_id, "refreshed github access token");

    Ok(access_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;
    use std::collections::HashMap;

    fn config() -> Config {
        Config {
            port: 1337,
            database_url: Secret::new("postgres://unused"),
            github_client_id: "test-client-id".into(),
            github_client_secret: Secret::new("test-client-secret"),
            github_callback_url: Url::parse(
                "http://localhost:1337/api/v1/auth/github/callback",
            )
            .unwrap(),
            frontend_url: Url::parse("http://localhost:5173").unwrap(),
            frontend_origin: "http://localhost:5173".into(),
            session_secret: Secret::new(
                "test-session-secret-that-is-long-enough-for-validation",
            ),
            github_webhook_secret: None,
            secure_cookies: false,
        }
    }

    fn client() -> GithubClient {
        GithubClient::for_test(
            &config(),
            Url::parse("https://github.com").unwrap(),
            Url::parse("https://api.github.com").unwrap(),
        )
    }

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_pkce_values_are_valid() {
        let (verifier, challenge) = generate_pkce().unwrap();

        assert!((43..=128).contains(&verifier.len()));
        assert_eq!(challenge.len(), 43);
        assert_ne!(verifier, challenge);
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }

    #[test]
    fn authorize_url_contains_required_parameters() {
        let url = client().authorize_url("state-value", "challenge-value").unwrap();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();

        assert_eq!(url.path(), "/login/oauth/authorize");
        assert_eq!(params["client_id"], "test-client-id");
        assert_eq!(
            params["redirect_uri"],
            "http://localhost:1337/api/v1/auth/github/callback"
        );
        assert_eq!(params["state"], "state-value");
        assert_eq!(params["code_challenge"], "challenge-value");
        assert_eq!(params["code_challenge_method"], "S256");
    }

    #[test]
    fn state_validation_rejects_mismatch_expiry_and_future_values() {
        let now = Utc::now();
        let payload = OAuthStatePayload {
            state: "expected".into(),
            code_verifier: "verifier".into(),
            created_at: now.timestamp(),
        };

        assert!(oauth_state_is_valid(&payload, "expected", now));
        assert!(!oauth_state_is_valid(&payload, "different", now));

        let expired = OAuthStatePayload {
            created_at: now.timestamp() - OAUTH_STATE_TTL_SECONDS - 1,
            ..payload
        };
        assert!(!oauth_state_is_valid(&expired, "expected", now));

        let future = OAuthStatePayload {
            created_at: now.timestamp() + 120,
            ..payload
        };
        assert!(!oauth_state_is_valid(&future, "expected", now));
    }
}
