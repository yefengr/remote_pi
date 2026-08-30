use base64::{Engine as _, engine::general_purpose::STANDARD};
use relay::PeerRegistry;
use relay::peers::registry::RouteOutcome;
use relay::protocol::outer::{EndpointKind, EndpointMetadata, HostHello, RouteFrame, RoutePurpose};
use tokio::sync::mpsc;

const ENDPOINT_ID: &str = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID: &str = "22222222-2222-4222-8222-222222222222";

fn id(byte: u8) -> String {
    STANDARD.encode([byte; 32])
}

fn metadata() -> EndpointMetadata {
    EndpointMetadata {
        kind: EndpointKind::Interactive,
        name: None,
        cwd: None,
        pid: None,
        started_at: None,
        model: None,
        thinking: None,
        working: None,
    }
}

fn host(device_id: String, owners: Vec<String>) -> HostHello {
    HostHello {
        device_id,
        endpoint_id: ENDPOINT_ID.to_owned(),
        runtime_instance_id: RUNTIME_ID.to_owned(),
        metadata: metadata(),
        authorized_owner_ids: owners.into_iter().collect(),
    }
}

fn route(device_id: String, target_owner_id: Option<String>) -> RouteFrame {
    RouteFrame {
        frame_type: "route".to_owned(),
        purpose: RoutePurpose::Session,
        device_id,
        endpoint_id: ENDPOINT_ID.to_owned(),
        runtime_instance_id: RUNTIME_ID.to_owned(),
        target_owner_id,
        source_owner_id: None,
        ct: "opaque route body".to_owned(),
    }
}

#[test]
fn host_routes_only_to_an_authorized_target_owner() {
    let registry = PeerRegistry::new();
    let device = id(1);
    let owner = id(2);
    let (owner_tx, mut owner_rx) = mpsc::unbounded_channel();
    registry.register_owner(owner.clone(), owner_tx);
    let (host_tx, _) = mpsc::unbounded_channel();
    let host_conn = registry.register_host(host(device.clone(), vec![owner.clone()]), host_tx);

    assert_eq!(
        registry.route_from_host(&device, ENDPOINT_ID, host_conn, route(device.clone(), None)),
        RouteOutcome::Unauthorized
    );
    assert_eq!(
        registry.route_from_host(
            &device,
            ENDPOINT_ID,
            host_conn,
            route(device.clone(), Some(id(3))),
        ),
        RouteOutcome::Unauthorized
    );
    assert_eq!(
        registry.route_from_host(
            &device,
            ENDPOINT_ID,
            host_conn,
            route(device.clone(), Some(owner.clone())),
        ),
        RouteOutcome::Delivered
    );
    let delivered = owner_rx.try_recv().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(delivered.to_text().unwrap()).unwrap()["ct"],
        "opaque route body"
    );
}
