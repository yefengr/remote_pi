use base64::{Engine as _, engine::general_purpose::STANDARD};
use relay::PeerRegistry;
use relay::protocol::outer::{EndpointKind, EndpointMetadata, EndpointUpdate, HostHello};
use tokio::sync::mpsc;

const ENDPOINT_ID: &str = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID: &str = "22222222-2222-4222-8222-222222222222";

fn id(byte: u8) -> String {
    STANDARD.encode([byte; 32])
}

fn metadata(name: Option<&str>) -> EndpointMetadata {
    EndpointMetadata {
        kind: EndpointKind::Daemon,
        name: name.map(str::to_owned),
        cwd: None,
        pid: Some(12),
        started_at: None,
        model: None,
        thinking: None,
        working: None,
    }
}

#[test]
fn endpoint_discovery_follows_the_in_memory_acl() {
    let registry = PeerRegistry::new();
    let device = id(1);
    let owner = id(2);
    let (owner_tx, mut owner_rx) = mpsc::unbounded_channel();
    let owner_conn = registry.register_owner(owner.clone(), owner_tx);
    assert!(registry.subscribe_endpoints(&owner, owner_conn, vec![device.clone()]));
    let empty_snapshot = owner_rx.try_recv().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(empty_snapshot.to_text().unwrap()).unwrap()["endpoints"],
        serde_json::json!([])
    );

    let (host_tx, _) = mpsc::unbounded_channel();
    let host_conn = registry.register_host(
        HostHello {
            device_id: device.clone(),
            endpoint_id: ENDPOINT_ID.to_owned(),
            runtime_instance_id: RUNTIME_ID.to_owned(),
            metadata: metadata(Some("initial")),
            authorized_owner_ids: [owner.clone()].into_iter().collect(),
        },
        host_tx,
    );
    let announced = owner_rx.try_recv().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(announced.to_text().unwrap()).unwrap()["type"],
        "endpoint_announced"
    );

    assert!(registry.update_host(
        &device,
        ENDPOINT_ID,
        host_conn,
        EndpointUpdate {
            metadata: Some(metadata(Some("updated"))),
            authorized_owner_ids: None,
        },
    ));
    let updated = owner_rx.try_recv().unwrap();
    let updated: serde_json::Value = serde_json::from_str(updated.to_text().unwrap()).unwrap();
    assert_eq!(updated["type"], "endpoint_updated");
    assert_eq!(updated["metadata"]["name"], "updated");

    assert!(registry.update_host(
        &device,
        ENDPOINT_ID,
        host_conn,
        EndpointUpdate {
            metadata: None,
            authorized_owner_ids: Some(Default::default()),
        },
    ));
    let ended = owner_rx.try_recv().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(ended.to_text().unwrap()).unwrap()["type"],
        "endpoint_ended"
    );
}
