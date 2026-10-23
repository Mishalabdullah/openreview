use std::sync::Arc;

use sqlx::PgPool;

use crate::{auth::github::GithubClient, config::Config, crypto::Crypto};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub crypto: Arc<Crypto>,
    pub github: GithubClient,
}
