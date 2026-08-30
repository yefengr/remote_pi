use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let port: u16 = std::env::var("REMOTEPI_RELAY_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    let state = relay::AppState {
        registry: Arc::new(relay::PeerRegistry::new()),
    };
    info!("relay listening on {addr} (WebSocket + /health)");

    axum::serve(
        listener,
        relay::build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            warn!(%error, "failed to wait for ctrl_c");
        } else {
            info!("ctrl_c received, shutting down");
        }
    })
    .await
    .context("axum::serve failed")?;

    Ok(())
}
