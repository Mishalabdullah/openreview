use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::TimeDelta;
use cookie::{
    Cookie, SameSite,
    time::{Duration, OffsetDateTime},
};
use sha2::{Digest, Sha256};

use crate::{config::Config, crypto::CryptoError};

pub const SESSION_COOKIE: &str = "openreview_session";
pub const OAUTH_COOKIE: &str = "openreview_oauth";
pub const OAUTH_STATE_TTL_SECONDS: i64 = 10 * 60;
pub const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

const SESSION_TOKEN_BYTES: usize = 32;
const OAUTH_COOKIE_PATH: &str = "/api/v1/auth/github";

pub fn session_ttl() -> TimeDelta {
    TimeDelta::seconds(SESSION_TTL_SECONDS)
}

pub fn generate_session_token() -> Result<String, CryptoError> {
    generate_random_token(SESSION_TOKEN_BYTES)
}

pub fn generate_random_token(byte_length: usize) -> Result<String, CryptoError> {
    let mut bytes = vec![0u8; byte_length];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::Random)?;

    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Session tokens are stored as a SHA-256 digest, never in plaintext.
pub fn hash_session_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

pub fn session_cookie(token: String, config: &Config) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .secure(config.secure_cookies)
        .same_site(SameSite::Lax)
        .max_age(Duration::seconds(SESSION_TTL_SECONDS))
        .build()
}

pub fn clear_session_cookie(config: &Config) -> Cookie<'static> {
    expired_cookie(SESSION_COOKIE, "/", config.secure_cookies)
}

pub fn oauth_cookie(value: String, config: &Config) -> Cookie<'static> {
    Cookie::build((OAUTH_COOKIE, value))
        .path(OAUTH_COOKIE_PATH)
        .http_only(true)
        .secure(config.secure_cookies)
        .same_site(SameSite::Lax)
        .max_age(Duration::seconds(OAUTH_STATE_TTL_SECONDS))
        .build()
}

pub fn clear_oauth_cookie(config: &Config) -> Cookie<'static> {
    expired_cookie(OAUTH_COOKIE, OAUTH_COOKIE_PATH, config.secure_cookies)
}

fn expired_cookie(name: &'static str, path: &'static str, secure: bool) -> Cookie<'static> {
    Cookie::build((name, ""))
        .path(path)
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::ZERO)
        .expires(OffsetDateTime::now_utc() - Duration::days(1))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;
    use url::Url;

    fn config() -> Config {
        Config {
            port: 1337,
            database_url: Secret::new("postgres://unused"),
            github_client_id: "client".into(),
            github_client_secret: Secret::new("secret"),
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

    #[test]
    fn session_tokens_are_random_and_url_safe() {
        let first = generate_session_token().unwrap();
        let second = generate_session_token().unwrap();

        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        assert!(
            first
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn session_hash_is_stable_and_does_not_contain_the_token() {
        let token = "test-session-token";
        let hash = hash_session_token(token);

        assert_eq!(hash, hash_session_token(token));
        assert_ne!(hash, token);
        assert!(!hash.contains(token));
    }

    #[test]
    fn session_cookie_has_security_attributes() {
        let cookie = session_cookie("token".into(), &config());
        let rendered = cookie.to_string();

        assert!(rendered.contains("HttpOnly"));
        assert!(rendered.contains("SameSite=Lax"));
        assert!(rendered.contains("Path=/"));
        assert!(rendered.contains("Max-Age=604800"));
        assert!(!rendered.contains("Secure"));
    }

    #[test]
    fn secure_configuration_sets_secure_cookies() {
        let mut config = config();
        config.secure_cookies = true;

        assert!(session_cookie("token".into(), &config).secure());
        assert!(oauth_cookie("state".into(), &config).secure());
    }

    #[test]
    fn oauth_cookie_is_scoped_and_short_lived() {
        let cookie = oauth_cookie("state".into(), &config());
        let rendered = cookie.to_string();

        assert!(rendered.contains("Path=/api/v1/auth/github"));
        assert!(rendered.contains("Max-Age=600"));
        assert!(rendered.contains("HttpOnly"));
    }
}
