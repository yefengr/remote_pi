use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::identity::canonical_ed25519_public_key;

pub const PROTOCOL_VERSION: u64 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Daemon,
    Interactive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointMetadata {
    pub kind: EndpointKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostHello {
    pub device_id: String,
    pub endpoint_id: String,
    pub runtime_instance_id: String,
    pub metadata: EndpointMetadata,
    pub authorized_owner_ids: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hello {
    Host(Box<HostHello>),
    Owner { owner_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutePurpose {
    Pairing,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub purpose: RoutePurpose,
    pub device_id: String,
    pub endpoint_id: String,
    pub runtime_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_owner_id: Option<String>,
    /// Injected by the relay on Owner → Host delivery; never supplied by an Owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_owner_id: Option<String>,
    pub ct: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointUpdate {
    pub metadata: Option<EndpointMetadata>,
    pub authorized_owner_ids: Option<HashSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EndpointInfo {
    pub endpoint_id: String,
    pub runtime_instance_id: String,
    pub metadata: EndpointMetadata,
}

#[derive(Debug, thiserror::Error)]
pub enum OuterError {
    #[error("invalid json: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("unknown outer frame type")]
    UnknownFrameType,
    #[error("unsupported protocol version")]
    UnsupportedProtocolVersion,
    #[error("non-canonical public key")]
    NonCanonicalPublicKey,
    #[error("invalid public key: {0}")]
    InvalidPublicKey(String),
    #[error("invalid opaque UUID")]
    InvalidUuid,
    #[error("invalid hello shape")]
    InvalidHello,
    #[error("invalid endpoint update")]
    InvalidEndpointUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WireRole {
    Host,
    Owner,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelloWire {
    #[serde(rename = "type")]
    frame_type: String,
    protocol_version: u64,
    role: WireRole,
    pubkey: String,
    endpoint_id: Option<String>,
    runtime_instance_id: Option<String>,
    metadata: Option<EndpointMetadata>,
    authorized_owner_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteWire {
    #[serde(rename = "type")]
    frame_type: String,
    purpose: RoutePurpose,
    device_id: String,
    endpoint_id: String,
    runtime_instance_id: String,
    target_owner_id: Option<String>,
    source_owner_id: Option<String>,
    ct: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubscribeEndpointsWire {
    #[serde(rename = "type")]
    frame_type: String,
    device_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EndpointUpdateWire {
    #[serde(rename = "type")]
    frame_type: String,
    metadata: Option<EndpointMetadata>,
    authorized_owner_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct FrameTypeWire {
    #[serde(rename = "type")]
    frame_type: String,
}

pub fn frame_type(line: &str) -> Result<String, OuterError> {
    Ok(serde_json::from_str::<FrameTypeWire>(line)?.frame_type)
}

pub fn parse_hello(line: &str) -> Result<Hello, OuterError> {
    let wire: HelloWire = serde_json::from_str(line)?;
    if wire.frame_type != "hello" {
        return Err(OuterError::UnknownFrameType);
    }
    if wire.protocol_version != PROTOCOL_VERSION {
        return Err(OuterError::UnsupportedProtocolVersion);
    }

    let identity = canonical_id(&wire.pubkey)?;
    match wire.role {
        WireRole::Host => {
            let endpoint_id = wire.endpoint_id.ok_or(OuterError::InvalidHello)?;
            let runtime_instance_id = wire.runtime_instance_id.ok_or(OuterError::InvalidHello)?;
            let metadata = wire.metadata.ok_or(OuterError::InvalidHello)?;
            if !is_uuid(&endpoint_id) || !is_uuid(&runtime_instance_id) {
                return Err(OuterError::InvalidUuid);
            }
            let authorized_owner_ids = wire
                .authorized_owner_ids
                .unwrap_or_default()
                .into_iter()
                .map(|owner_id| canonical_id(&owner_id))
                .collect::<Result<HashSet<_>, _>>()?;
            Ok(Hello::Host(Box::new(HostHello {
                device_id: identity,
                endpoint_id,
                runtime_instance_id,
                metadata,
                authorized_owner_ids,
            })))
        }
        WireRole::Owner => {
            if wire.endpoint_id.is_some()
                || wire.runtime_instance_id.is_some()
                || wire.metadata.is_some()
                || wire.authorized_owner_ids.is_some()
            {
                return Err(OuterError::InvalidHello);
            }
            Ok(Hello::Owner { owner_id: identity })
        }
    }
}

pub fn parse_route(line: &str) -> Result<RouteFrame, OuterError> {
    let wire: RouteWire = serde_json::from_str(line)?;
    if wire.frame_type != "route" {
        return Err(OuterError::UnknownFrameType);
    }
    if !is_uuid(&wire.endpoint_id) || !is_uuid(&wire.runtime_instance_id) {
        return Err(OuterError::InvalidUuid);
    }
    Ok(RouteFrame {
        frame_type: "route".to_string(),
        purpose: wire.purpose,
        device_id: canonical_id(&wire.device_id)?,
        endpoint_id: wire.endpoint_id,
        runtime_instance_id: wire.runtime_instance_id,
        target_owner_id: wire
            .target_owner_id
            .map(|owner_id| canonical_id(&owner_id))
            .transpose()?,
        source_owner_id: wire
            .source_owner_id
            .map(|owner_id| canonical_id(&owner_id))
            .transpose()?,
        ct: wire.ct,
    })
}

pub fn parse_subscribe_endpoints(line: &str) -> Result<Vec<String>, OuterError> {
    let wire: SubscribeEndpointsWire = serde_json::from_str(line)?;
    if wire.frame_type != "subscribe_endpoints" {
        return Err(OuterError::UnknownFrameType);
    }
    wire.device_ids
        .into_iter()
        .map(|device_id| canonical_id(&device_id))
        .collect()
}

pub fn parse_endpoint_update(line: &str) -> Result<EndpointUpdate, OuterError> {
    let wire: EndpointUpdateWire = serde_json::from_str(line)?;
    if wire.frame_type != "endpoint_update" {
        return Err(OuterError::UnknownFrameType);
    }
    if wire.metadata.is_none() && wire.authorized_owner_ids.is_none() {
        return Err(OuterError::InvalidEndpointUpdate);
    }
    let authorized_owner_ids = wire
        .authorized_owner_ids
        .map(|owner_ids| {
            owner_ids
                .into_iter()
                .map(|owner_id| canonical_id(&owner_id))
                .collect::<Result<HashSet<_>, _>>()
        })
        .transpose()?;
    Ok(EndpointUpdate {
        metadata: wire.metadata,
        authorized_owner_ids,
    })
}

pub fn endpoints_line(device_id: &str, endpoints: Vec<EndpointInfo>) -> Option<String> {
    #[derive(Serialize)]
    struct EndpointsFrame<'a> {
        #[serde(rename = "type")]
        frame_type: &'static str,
        device_id: &'a str,
        endpoints: Vec<EndpointInfo>,
    }

    serde_json::to_string(&EndpointsFrame {
        frame_type: "endpoints",
        device_id,
        endpoints,
    })
    .ok()
}

pub fn endpoint_announced_line(device_id: &str, endpoint: &EndpointInfo) -> Option<String> {
    endpoint_event_line("endpoint_announced", device_id, endpoint, true)
}

pub fn endpoint_updated_line(device_id: &str, endpoint: &EndpointInfo) -> Option<String> {
    endpoint_event_line("endpoint_updated", device_id, endpoint, true)
}

pub fn endpoint_ended_line(device_id: &str, endpoint: &EndpointInfo) -> Option<String> {
    endpoint_event_line("endpoint_ended", device_id, endpoint, false)
}

fn endpoint_event_line(
    frame_type: &'static str,
    device_id: &str,
    endpoint: &EndpointInfo,
    include_metadata: bool,
) -> Option<String> {
    #[derive(Serialize)]
    struct EndpointEvent<'a> {
        #[serde(rename = "type")]
        frame_type: &'static str,
        device_id: &'a str,
        endpoint_id: &'a str,
        runtime_instance_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<&'a EndpointMetadata>,
    }

    serde_json::to_string(&EndpointEvent {
        frame_type,
        device_id,
        endpoint_id: &endpoint.endpoint_id,
        runtime_instance_id: &endpoint.runtime_instance_id,
        metadata: include_metadata.then_some(&endpoint.metadata),
    })
    .ok()
}

fn canonical_id(value: &str) -> Result<String, OuterError> {
    let canonical = canonical_ed25519_public_key(value)
        .map_err(|error| OuterError::InvalidPublicKey(error.to_string()))?;
    if canonical != value {
        return Err(OuterError::NonCanonicalPublicKey);
    }
    Ok(canonical)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::*;

    fn device_id(byte: u8) -> String {
        STANDARD.encode([byte; 32])
    }

    fn metadata() -> serde_json::Value {
        serde_json::json!({"kind": "daemon", "pid": 42})
    }

    #[test]
    fn parses_strict_host_hello() {
        let host_device_id = device_id(1);
        let hello = serde_json::json!({
            "type": "hello",
            "protocol_version": 2,
            "role": "host",
            "pubkey": host_device_id,
            "endpoint_id": "11111111-1111-4111-8111-111111111111",
            "runtime_instance_id": "22222222-2222-4222-8222-222222222222",
            "metadata": metadata(),
            "authorized_owner_ids": [device_id(2)],
        });

        let parsed = parse_hello(&hello.to_string()).unwrap();
        let Hello::Host(host) = parsed else {
            panic!("host hello expected");
        };
        assert_eq!(host.device_id, host_device_id);
        assert!(host.authorized_owner_ids.contains(&device_id(2)));
        assert_eq!(host.metadata.kind, EndpointKind::Daemon);
    }

    #[test]
    fn rejects_room_and_noncanonical_hello_fields() {
        let hello = serde_json::json!({
            "type": "hello",
            "protocol_version": 2,
            "role": "owner",
            "pubkey": STANDARD.encode([3; 32]),
            "room_id": "main",
        });
        assert!(matches!(
            parse_hello(&hello.to_string()),
            Err(OuterError::InvalidJson(_))
        ));

        let url_safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3; 32]);
        let hello = serde_json::json!({
            "type": "hello",
            "protocol_version": 2,
            "role": "owner",
            "pubkey": url_safe,
        });
        assert!(matches!(
            parse_hello(&hello.to_string()),
            Err(OuterError::NonCanonicalPublicKey)
        ));
    }

    #[test]
    fn route_leaves_ct_opaque() {
        let mut route = serde_json::json!({
            "type": "route",
            "purpose": "session",
            "device_id": device_id(4),
            "endpoint_id": "11111111-1111-4111-8111-111111111111",
            "runtime_instance_id": "22222222-2222-4222-8222-222222222222",
            "ct": "this is neither base64 nor JSON",
        });
        let parsed = parse_route(&route.to_string()).unwrap();
        assert_eq!(parsed.ct, "this is neither base64 nor JSON");
        assert!(parsed.target_owner_id.is_none());

        route["room"] = serde_json::json!("main");
        assert!(matches!(
            parse_route(&route.to_string()),
            Err(OuterError::InvalidJson(_))
        ));

        route.as_object_mut().unwrap().remove("room");
        route["source_owner_id"] = serde_json::json!(device_id(5));
        let parsed = parse_route(&route.to_string()).unwrap();
        assert_eq!(parsed.source_owner_id, Some(device_id(5)));
    }
}
