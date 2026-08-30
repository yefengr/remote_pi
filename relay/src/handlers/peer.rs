use std::net::SocketAddr;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{self, Duration};
use tracing::{info, warn};

use crate::AppState;
use crate::auth::challenge::{
    HELLO_TIMEOUT_MS, challenge_line, gen_nonce, parse_hello as parse_auth_hello, verify_auth,
};
use crate::peers::registry::RouteOutcome;
use crate::protocol::outer::{
    Hello, HostHello, frame_type, parse_endpoint_update, parse_hello, parse_route,
    parse_subscribe_endpoints,
};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_peer(socket, addr, state))
}

#[derive(Debug, Clone)]
enum Connection {
    Host {
        device_id: String,
        endpoint_id: String,
        conn_id: u64,
    },
    Owner {
        owner_id: String,
        conn_id: u64,
    },
}

async fn handle_peer(socket: WebSocket, peer_addr: SocketAddr, state: AppState) {
    let peer_addr = peer_addr.to_string();
    let (mut sink, mut stream) = socket.split();

    let hello_text =
        match tokio::time::timeout(Duration::from_millis(HELLO_TIMEOUT_MS), stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => text,
            _ => {
                warn!(addr = %peer_addr, "no hello received, closing");
                return;
            }
        };

    let hello = match parse_hello(&hello_text) {
        Ok(hello) => hello,
        Err(error) => {
            warn!(addr = %peer_addr, error = %error, "invalid endpoint hello, closing");
            return;
        }
    };
    let verifying_key = match parse_auth_hello(&hello_text) {
        Ok(key) => key,
        Err(error) => {
            warn!(addr = %peer_addr, error = %error, "invalid auth hello, closing");
            return;
        }
    };

    let (nonce, nonce_b64) = gen_nonce();
    if sink
        .send(Message::Text(challenge_line(&nonce_b64)))
        .await
        .is_err()
    {
        return;
    }

    let auth_text = match stream.next().await {
        Some(Ok(Message::Text(text))) => text,
        _ => return,
    };
    if let Err(error) = verify_auth(&nonce, &verifying_key, &auth_text) {
        warn!(addr = %peer_addr, error = %error, "auth failed, closing");
        let _ = sink.send(Message::Close(None)).await;
        return;
    }

    let authenticated_id = B64.encode(verifying_key.to_bytes());
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let connection = register_connection(&state, hello, &authenticated_id, tx);
    let Some(connection) = connection else {
        warn!(addr = %peer_addr, "authenticated identity did not match hello, closing");
        return;
    };

    info!(addr = %peer_addr, role = connection.role(), "endpoint connection authenticated");
    let mut heartbeat = time::interval_at(
        time::Instant::now() + Duration::from_secs(25),
        Duration::from_secs(25),
    );

    loop {
        tokio::select! {
            item = stream.next() => {
                match item {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Binary(_))) => continue,
                    Some(Ok(Message::Text(text))) => handle_frame(&state, &connection, &text),
                }
            }
            message = rx.recv() => {
                match message {
                    Some(message) => {
                        if sink.send(message).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    unregister_connection(&state, &connection);
    info!(addr = %peer_addr, role = connection.role(), "endpoint connection disconnected");
}

fn register_connection(
    state: &AppState,
    hello: Hello,
    authenticated_id: &str,
    tx: mpsc::UnboundedSender<Message>,
) -> Option<Connection> {
    match hello {
        Hello::Host(host) if host.device_id == authenticated_id => {
            Some(register_host(state, *host, tx))
        }
        Hello::Owner { owner_id } if owner_id == authenticated_id => {
            let conn_id = state.registry.register_owner(owner_id.clone(), tx);
            Some(Connection::Owner { owner_id, conn_id })
        }
        _ => None,
    }
}

fn register_host(
    state: &AppState,
    host: HostHello,
    tx: mpsc::UnboundedSender<Message>,
) -> Connection {
    let device_id = host.device_id.clone();
    let endpoint_id = host.endpoint_id.clone();
    let conn_id = state.registry.register_host(host, tx);
    Connection::Host {
        device_id,
        endpoint_id,
        conn_id,
    }
}

fn handle_frame(state: &AppState, connection: &Connection, text: &str) {
    let frame_type = match frame_type(text) {
        Ok(frame_type) => frame_type,
        Err(error) => {
            warn!(role = connection.role(), error = %error, "invalid endpoint frame, dropping");
            return;
        }
    };

    match (connection, frame_type.as_str()) {
        (Connection::Owner { owner_id, conn_id }, "subscribe_endpoints") => {
            match parse_subscribe_endpoints(text) {
                Ok(device_ids) => {
                    if !state
                        .registry
                        .subscribe_endpoints(owner_id, *conn_id, device_ids)
                    {
                        warn!(role = "owner", "stale owner subscription, dropping");
                    }
                }
                Err(error) => {
                    warn!(role = "owner", error = %error, "invalid endpoint subscription, dropping")
                }
            }
        }
        (
            Connection::Host {
                device_id,
                endpoint_id,
                conn_id,
            },
            "endpoint_update",
        ) => match parse_endpoint_update(text) {
            Ok(update) => {
                if !state
                    .registry
                    .update_host(device_id, endpoint_id, *conn_id, update)
                {
                    warn!(role = "host", "stale endpoint update, dropping");
                }
            }
            Err(error) => warn!(role = "host", error = %error, "invalid endpoint update, dropping"),
        },
        (Connection::Owner { owner_id, conn_id }, "route") => match parse_route(text) {
            Ok(route) => {
                log_route_outcome(state.registry.route_from_owner(owner_id, *conn_id, route))
            }
            Err(error) => warn!(role = "owner", error = %error, "invalid owner route, dropping"),
        },
        (
            Connection::Host {
                device_id,
                endpoint_id,
                conn_id,
            },
            "route",
        ) => match parse_route(text) {
            Ok(route) => log_route_outcome(state.registry.route_from_host(
                device_id,
                endpoint_id,
                *conn_id,
                route,
            )),
            Err(error) => warn!(role = "host", error = %error, "invalid host route, dropping"),
        },
        (Connection::Owner { .. }, "endpoint_update")
        | (Connection::Host { .. }, "subscribe_endpoints") => {
            warn!(
                role = connection.role(),
                frame_type, "control frame is not allowed for this role"
            );
        }
        _ => warn!(
            role = connection.role(),
            frame_type, "unknown endpoint control frame, dropping"
        ),
    }
}

fn log_route_outcome(outcome: RouteOutcome) {
    if outcome != RouteOutcome::Delivered {
        warn!(?outcome, "endpoint route was not forwarded");
    }
}

fn unregister_connection(state: &AppState, connection: &Connection) {
    match connection {
        Connection::Host {
            device_id,
            endpoint_id,
            conn_id,
        } => state
            .registry
            .unregister_host(device_id, endpoint_id, *conn_id),
        Connection::Owner { owner_id, conn_id } => {
            state.registry.unregister_owner(owner_id, *conn_id)
        }
    }
}

impl Connection {
    fn role(&self) -> &'static str {
        match self {
            Self::Host { .. } => "host",
            Self::Owner { .. } => "owner",
        }
    }
}
