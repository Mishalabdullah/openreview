use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::models::{GithubUser, User};

#[derive(Debug, Clone)]
pub struct GithubTokens {
    pub access_token_encrypted: String,
    pub refresh_token_encrypted: Option<String>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub refresh_token_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GithubConnection {
    pub id: Uuid,
    pub user_id: Uuid,
    pub access_token_encrypted: String,
    pub refresh_token_encrypted: Option<String>,
    pub token_expires_at: Option<DateTime<Utc>>,
    pub refresh_token_expires_at: Option<DateTime<Utc>>,
}

/// Persists the GitHub identity, encrypted GitHub credentials, and a new
/// application session in one transaction.
pub async fn create_login(
    pool: &PgPool,
    github_user: &GithubUser,
    tokens: &GithubTokens,
    session_token_hash: &str,
    session_expires_at: DateTime<Utc>,
) -> Result<User, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (
            id, github_id, github_username, display_name, avatar_url, email,
            created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, now(), now())
        ON CONFLICT (github_id) DO UPDATE SET
            github_username = EXCLUDED.github_username,
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            email = EXCLUDED.email,
            updated_at = now()
        RETURNING
            id, github_id, github_username, display_name, avatar_url, email,
            created_at, updated_at
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(github_user.id)
    .bind(&github_user.login)
    .bind(&github_user.name)
    .bind(&github_user.avatar_url)
    .bind(&github_user.email)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO github_connections (
            id, user_id, access_token_encrypted, refresh_token_encrypted,
            token_expires_at, refresh_token_expires_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, now(), now())
        ON CONFLICT (user_id) DO UPDATE SET
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            token_expires_at = EXCLUDED.token_expires_at,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            updated_at = now()
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(&tokens.access_token_encrypted)
    .bind(&tokens.refresh_token_encrypted)
    .bind(tokens.token_expires_at)
    .bind(tokens.refresh_token_expires_at)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, now())
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(session_token_hash)
    .bind(session_expires_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(user)
}

pub async fn find_user_by_session_token_hash(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Option<User>, sqlx::Error> {
    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT
            u.id, u.github_id, u.github_username, u.display_name, u.avatar_url,
            u.email, u.created_at, u.updated_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;

    if user.is_none() {
        // Best-effort cleanup of an expired row. Never fail auth because of it.
        let _ = sqlx::query(
            "DELETE FROM sessions WHERE token_hash = $1 AND expires_at <= now()",
        )
        .bind(token_hash)
        .execute(pool)
        .await;
    }

    Ok(user)
}

pub async fn revoke_session(pool: &PgPool, token_hash: &str) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(token_hash)
        .execute(pool)
        .await?;

    Ok(result.rows_affected())
}

pub async fn load_connection_for_update(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<Option<GithubConnection>, sqlx::Error> {
    sqlx::query_as::<_, GithubConnection>(
        r#"
        SELECT
            id, user_id, access_token_encrypted, refresh_token_encrypted,
            token_expires_at, refresh_token_expires_at
        FROM github_connections
        WHERE user_id = $1
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
}

pub async fn update_connection_tokens(
    tx: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    tokens: &GithubTokens,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE github_connections
        SET
            access_token_encrypted = $2,
            refresh_token_encrypted = $3,
            token_expires_at = $4,
            refresh_token_expires_at = $5,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(connection_id)
    .bind(&tokens.access_token_encrypted)
    .bind(&tokens.refresh_token_encrypted)
    .bind(tokens.token_expires_at)
    .bind(tokens.refresh_token_expires_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn delete_connection(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM github_connections WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;

    Ok(())
}
