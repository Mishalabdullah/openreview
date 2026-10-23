mod app;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod models;
mod state;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::{
    auth::github::GithubClient,
    config::Config,
    crypto::Crypto,
    error::AppError,
    state::AppState,
};

#[tokio::main]
async fn main() {
    init_tracing();

    if let Err(error) = run().await {
        tracing::error!(error = %error, "fatal error");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), AppError> {
    dotenvy::dotenv().ok();

    let config = Config::from_env().map_err(|error| AppError::Config(error.to_string()))?;

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(config.database_url.expose())
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("database connected and migrations applied");

    let crypto = Arc::new(Crypto::new(&config.session_secret));
    let github = GithubClient::new(&config)?;
    let state = AppState {
        pool,
        config: Arc::new(config),
        crypto,
        github,
    };

    let router = app::build_router(state.clone());
    let addr = SocketAddr::from(([0, 0, 0, 0], state.config.port));
    let listener = TcpListener::bind(addr).await.map_err(|error| {
        tracing::error!(%error, %addr, "failed to bind address");
        AppError::Internal("failed to bind server address")
    })?;

    tracing::info!(
        %addr,
        secure_cookies = state.config.secure_cookies,
        "api server listening"
    );

    axum::serve(listener, router).await.map_err(|error| {
        tracing::error!(%error, "server error");
        AppError::Internal("server error")
    })?;

    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("api_server=info,tower_http=warn"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}
