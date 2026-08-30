use std::net::SocketAddr;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use relay::{AppState, PeerRegistry, build_router};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const ENDPOINT_ID: &str = "11111111-1111-4111-8111-111111111111";
const RUNTIME_A: &str = "22222222-2222-4222-8222-222222222222";
const RUNTIME_B: &str = "33333333-3333-4333-8333-333333333333";

async fn start_relay() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = AppState {
        registry: Arc::new(PeerRegistry::new()),
    };
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    port
}

fn id(signing_key: &SigningKey) -> String {
    STANDARD.encode(signing_key.verifying_key().to_bytes())
}

async fn authenticate(port: u16, signing_key: &SigningKey, hello: Value) -> WsStream {
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}"))
        .await
        .unwrap();
    ws.send(Message::text(hello.to_string())).await.unwrap();
    let challenge = recv_json(&mut ws).await;
    let nonce: [u8; 32] = STANDARD
        .decode(challenge["nonce"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let signature = signing_key.sign(&nonce);
    ws.send(Message::text(
        json!({"type": "auth", "sig": STANDARD.encode(signature.to_bytes())}).to_string(),
    ))
    .await
    .unwrap();
    ws
}

async fn connect_owner(port: u16, signing_key: &SigningKey) -> WsStream {
    authenticate(
        port,
        signing_key,
        json!({
            "type": "hello",
            "protocol_version": 2,
            "role": "owner",
            "pubkey": id(signing_key),
        }),
    )
    .await
}

async fn connect_host(
    port: u16,
    signing_key: &SigningKey,
    runtime_instance_id: &str,
    authorized_owner_ids: &[String],
) -> WsStream {
    authenticate(
        port,
        signing_key,
        json!({
            "type": "hello",
            "protocol_version": 2,
            "role": "host",
            "pubkey": id(signing_key),
            "endpoint_id": ENDPOINT_ID,
            "runtime_instance_id": runtime_instance_id,
            "metadata": {"kind": "daemon", "name": "test host", "pid": 7},
            "authorized_owner_ids": authorized_owner_ids,
        }),
    )
    .await
}

async fn recv_json(ws: &mut WsStream) -> Value {
    let message = tokio::time::timeout(tokio::time::Duration::from_secs(1), ws.next())
        .await
        .expect("timed out waiting for a relay frame")
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}

fn route(
    device_id: &str,
    runtime_instance_id: &str,
    purpose: &str,
    target_owner_id: Option<&str>,
    ct: &str,
) -> Value {
    let mut frame = json!({
        "type": "route",
        "purpose": purpose,
        "device_id": device_id,
        "endpoint_id": ENDPOINT_ID,
        "runtime_instance_id": runtime_instance_id,
        "ct": ct,
    });
    if let Some(target_owner_id) = target_owner_id {
        frame["target_owner_id"] = Value::String(target_owner_id.to_owned());
    }
    frame
}

#[tokio::test]
async fn authorized_owner_discovers_and_routes_opaque_payload() {
    let port = start_relay().await;
    let host_key = SigningKey::generate(&mut rand::thread_rng());
    let owner_key = SigningKey::generate(&mut rand::thread_rng());
    let device_id = id(&host_key);
    let owner_id = id(&owner_key);
    let mut host = connect_host(port, &host_key, RUNTIME_A, std::slice::from_ref(&owner_id)).await;
    let mut owner = connect_owner(port, &owner_key).await;

    owner
        .send(Message::text(
            json!({"type": "subscribe_endpoints", "device_ids": [device_id]}).to_string(),
        ))
        .await
        .unwrap();
    let snapshot = recv_json(&mut owner).await;
    assert_eq!(snapshot["type"], "endpoints");
    assert_eq!(snapshot["endpoints"][0]["endpoint_id"], ENDPOINT_ID);
    assert_eq!(snapshot["endpoints"][0]["runtime_instance_id"], RUNTIME_A);

    let opaque_ct = "not-base64; not JSON; relay must not inspect this";
    owner
        .send(Message::text(
            route(&device_id, RUNTIME_A, "session", None, opaque_ct).to_string(),
        ))
        .await
        .unwrap();
    let to_host = recv_json(&mut host).await;
    assert_eq!(to_host["ct"], opaque_ct);
    assert!(to_host["target_owner_id"].is_null());
    assert_eq!(to_host["source_owner_id"], owner_id);

    host.send(Message::text(
        route(&device_id, RUNTIME_A, "session", Some(&owner_id), opaque_ct).to_string(),
    ))
    .await
    .unwrap();
    let to_owner = recv_json(&mut owner).await;
    assert_eq!(to_owner["ct"], opaque_ct);
    assert_eq!(to_owner["target_owner_id"], owner_id);
}

#[tokio::test]
async fn unapproved_owner_only_reaches_host_for_pairing() {
    let port = start_relay().await;
    let host_key = SigningKey::generate(&mut rand::thread_rng());
    let unapproved_owner_key = SigningKey::generate(&mut rand::thread_rng());
    let device_id = id(&host_key);
    let mut host = connect_host(port, &host_key, RUNTIME_A, &[]).await;
    let mut owner = connect_owner(port, &unapproved_owner_key).await;

    owner
        .send(Message::text(
            route(&device_id, RUNTIME_A, "session", None, "blocked").to_string(),
        ))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(tokio::time::Duration::from_millis(150), host.next())
            .await
            .is_err(),
        "session route without ACL must not reach host"
    );

    owner
        .send(Message::text(
            route(&device_id, RUNTIME_A, "pairing", None, "pair request").to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut host).await["ct"], "pair request");
}

#[tokio::test]
async fn new_runtime_takes_over_and_rejects_old_routes() {
    let port = start_relay().await;
    let host_key = SigningKey::generate(&mut rand::thread_rng());
    let owner_key = SigningKey::generate(&mut rand::thread_rng());
    let device_id = id(&host_key);
    let owner_id = id(&owner_key);
    let mut host_a =
        connect_host(port, &host_key, RUNTIME_A, std::slice::from_ref(&owner_id)).await;
    let mut owner = connect_owner(port, &owner_key).await;
    owner
        .send(Message::text(
            json!({"type": "subscribe_endpoints", "device_ids": [device_id]}).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_json(&mut owner).await;

    let mut host_b =
        connect_host(port, &host_key, RUNTIME_B, std::slice::from_ref(&owner_id)).await;
    let update = recv_json(&mut owner).await;
    assert_eq!(update["type"], "endpoint_updated");
    assert_eq!(update["runtime_instance_id"], RUNTIME_B);

    owner
        .send(Message::text(
            route(&device_id, RUNTIME_A, "session", None, "late old runtime").to_string(),
        ))
        .await
        .unwrap();
    match tokio::time::timeout(tokio::time::Duration::from_millis(150), host_a.next()).await {
        Err(_) | Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => {}
        Ok(Some(Ok(message))) => panic!("old runtime received a frame: {message:?}"),
    }

    owner
        .send(Message::text(
            route(&device_id, RUNTIME_B, "session", None, "new runtime").to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut host_b).await["ct"], "new runtime");
}
