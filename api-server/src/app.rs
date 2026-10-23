use axum::{
    Json, Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{get, post},
};
use serde::Serialize;
use tower_http::cors::CorsLayer;

use crate::{
    auth::{github, middleware::no_store},
    state::AppState,
};

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub fn build_router(state: AppState) -> Router {
    let allowed_origin = state
        .config
        .frontend_origin
        .parse::<HeaderValue>()
        .expect("frontend origin was validated at startup");

    let cors = CorsLayer::new()
        .allow_origin(allowed_origin)
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::ACCEPT, header::CONTENT_TYPE]);

    let auth_routes = Router::new()
        .route("/github", get(github::login))
        .route("/github/callback", get(github::callback))
        .route("/me", get(github::me))
        .route("/logout", post(github::logout))
        .layer(middleware::from_fn(no_store));

    Router::new()
        .route("/health", get(health))
        .nest("/api/v1/auth", auth_routes)
        .layer(cors)
        .with_state(state)
}
