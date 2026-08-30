pub mod auth;
pub mod handlers;
mod identity;
pub mod peers;
pub mod protocol;

use std::sync::Arc;

use axum::{Router, routing::get};

pub use peers::registry::PeerRegistry;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<PeerRegistry>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(handlers::peer::ws_handler))
        .route("/health", get(|| async { "OK" }))
        .with_state(state)
}
