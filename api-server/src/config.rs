use std::fmt;

use thiserror::Error;
use url::Url;

/// A value that must never be printed or serialized.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, Error)]
#[error("{0}")]
pub struct ConfigError(String);

impl ConfigError {
    fn missing(name: &str) -> Self {
        Self(format!(
            "missing required environment variable `{name}`; see api-server/README.md"
        ))
    }

    fn invalid(name: &str, reason: &str) -> Self {
        Self(format!("invalid `{name}`: {reason}"))
    }

    fn legacy(old: &str, new: &str) -> Self {
        Self(format!(
            "`{old}` is set but is no longer supported; rename it to `{new}`"
        ))
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: Secret,
    pub github_client_id: String,
    pub github_client_secret: Secret,
    pub github_callback_url: Url,
    pub frontend_url: Url,
    /// Serialized origin used for CORS and CSRF checks.
    pub frontend_origin: String,
    pub session_secret: Secret,
    /// Reserved for webhook verification, which is outside the current auth scope.
    #[allow(dead_code)]
    pub github_webhook_secret: Option<Secret>,
    /// Secure cookies whenever the public callback URL uses HTTPS.
    pub secure_cookies: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        if optional_var("GITHUB_CLIENT_SECRET").is_none()
            && optional_var("GITHUB_CLIENT_SECRECT").is_some()
        {
            return Err(ConfigError::legacy(
                "GITHUB_CLIENT_SECRECT",
                "GITHUB_CLIENT_SECRET",
            ));
        }

        if optional_var("GITHUB_WEBHOOK_SECRET").is_none()
            && optional_var("WEBHOOK_SECRECT").is_some()
        {
            return Err(ConfigError::legacy(
                "WEBHOOK_SECRECT",
                "GITHUB_WEBHOOK_SECRET",
            ));
        }

        let port = match optional_var("PORT") {
            Some(value) => value
                .parse::<u16>()
                .map_err(|_| ConfigError::invalid("PORT", "must be a valid TCP port"))?,
            None => 1337,
        };

        let database_url = Secret::new(required_var("DATABASE_URL")?);
        let github_client_id = required_var("GITHUB_CLIENT_ID")?;
        let github_client_secret = Secret::new(required_var("GITHUB_CLIENT_SECRET")?);
        let session_secret = Secret::new(required_var("SESSION_SECRET")?);

        if session_secret.expose().len() < 32 {
            return Err(ConfigError::invalid(
                "SESSION_SECRET",
                "must be at least 32 characters; generate one with `openssl rand -base64 48`",
            ));
        }

        let github_callback_url = parse_url(
            "GITHUB_CALLBACK_URL",
            &required_var("GITHUB_CALLBACK_URL")?,
        )?;
        if !matches!(github_callback_url.scheme(), "http" | "https") {
            return Err(ConfigError::invalid(
                "GITHUB_CALLBACK_URL",
                "must use http or https",
            ));
        }

        let frontend_url = parse_url("FRONTEND_URL", &required_var("FRONTEND_URL")?)?;
        if !matches!(frontend_url.scheme(), "http" | "https") {
            return Err(ConfigError::invalid("FRONTEND_URL", "must use http or https"));
        }

        let frontend_origin = frontend_url.origin().ascii_serialization();
        let secure_cookies = github_callback_url.scheme() == "https";

        Ok(Self {
            port,
            database_url,
            github_client_id,
            github_client_secret,
            github_callback_url,
            frontend_url,
            frontend_origin,
            session_secret,
            github_webhook_secret: optional_var("GITHUB_WEBHOOK_SECRET").map(Secret::new),
            secure_cookies,
        })
    }
}

fn required_var(name: &str) -> Result<String, ConfigError> {
    optional_var(name).ok_or_else(|| ConfigError::missing(name))
}

fn optional_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn parse_url(name: &str, value: &str) -> Result<Url, ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError::invalid(name, "must be an absolute URL"))?;

    if url.host_str().is_none() {
        return Err(ConfigError::invalid(name, "must include a host"));
    }

    Ok(url)
}
