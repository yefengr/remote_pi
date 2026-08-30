use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use axum::extract::ws::Message;
use tokio::sync::mpsc;
use tracing::warn;

use crate::protocol::outer::{
    EndpointInfo, EndpointUpdate, HostHello, RouteFrame, RoutePurpose, endpoint_announced_line,
    endpoint_ended_line, endpoint_updated_line, endpoints_line,
};

type EndpointKey = (String, String);
type Outbound = mpsc::UnboundedSender<Message>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteOutcome {
    Delivered,
    Unauthorized,
    Stale,
    Unavailable,
}

#[derive(Debug)]
struct HostConnection {
    conn_id: u64,
    runtime_instance_id: String,
    metadata: crate::protocol::outer::EndpointMetadata,
    authorized_owner_ids: HashSet<String>,
    tx: Outbound,
}

#[derive(Debug)]
struct OwnerConnection {
    tx: Outbound,
    subscribed_device_ids: HashSet<String>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    endpoints: HashMap<EndpointKey, HostConnection>,
    owners: HashMap<String, HashMap<u64, OwnerConnection>>,
}

/// In-memory routing authority for endpoint connections.
///
/// A `(device_id, endpoint_id)` has one live runtime. Registering another
/// runtime under the same key atomically replaces the previous connection;
/// stale handlers cannot route or publish updates after that replacement.
#[derive(Debug, Default)]
pub struct PeerRegistry {
    next_conn_id: AtomicU64,
    inner: Mutex<RegistryInner>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_host(&self, hello: HostHello, tx: Outbound) -> u64 {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let key = (hello.device_id, hello.endpoint_id);
        let host = HostConnection {
            conn_id,
            runtime_instance_id: hello.runtime_instance_id,
            metadata: hello.metadata,
            authorized_owner_ids: hello.authorized_owner_ids,
            tx,
        };

        let notifications = {
            let mut inner = self.lock();
            let previous = inner.endpoints.insert(key.clone(), host);
            let current = inner.endpoints.get(&key);
            Self::visibility_delta(&inner, &key, previous.as_ref(), current)
        };
        send_notifications(notifications);
        conn_id
    }

    pub fn register_owner(&self, owner_id: String, tx: Outbound) -> u64 {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        self.lock().owners.entry(owner_id).or_default().insert(
            conn_id,
            OwnerConnection {
                tx,
                subscribed_device_ids: HashSet::new(),
            },
        );
        conn_id
    }

    pub fn unregister_host(&self, device_id: &str, endpoint_id: &str, conn_id: u64) {
        let key = (device_id.to_owned(), endpoint_id.to_owned());
        let notifications = {
            let mut inner = self.lock();
            let is_current = inner
                .endpoints
                .get(&key)
                .is_some_and(|host| host.conn_id == conn_id);
            if !is_current {
                return;
            }
            let previous = inner.endpoints.remove(&key);
            Self::visibility_delta(&inner, &key, previous.as_ref(), None)
        };
        send_notifications(notifications);
    }

    pub fn unregister_owner(&self, owner_id: &str, conn_id: u64) {
        let mut inner = self.lock();
        let should_remove_owner = match inner.owners.get_mut(owner_id) {
            Some(connections) => {
                connections.remove(&conn_id);
                connections.is_empty()
            }
            None => false,
        };
        if should_remove_owner {
            inner.owners.remove(owner_id);
        }
    }

    pub fn subscribe_endpoints(
        &self,
        owner_id: &str,
        conn_id: u64,
        device_ids: Vec<String>,
    ) -> bool {
        let mut inner = self.lock();
        let device_ids: HashSet<String> = device_ids.into_iter().collect();
        let tx = {
            let Some(connections) = inner.owners.get_mut(owner_id) else {
                return false;
            };
            let Some(owner) = connections.get_mut(&conn_id) else {
                return false;
            };
            owner.subscribed_device_ids = device_ids.clone();
            owner.tx.clone()
        };

        let snapshots = device_ids.into_iter().filter_map(|device_id| {
            let endpoints = inner
                .endpoints
                .iter()
                .filter(|((registered_device_id, _), host)| {
                    registered_device_id == &device_id
                        && host.authorized_owner_ids.contains(owner_id)
                })
                .map(|((_, registered_endpoint_id), host)| {
                    endpoint_info(host, registered_endpoint_id)
                })
                .collect();
            endpoints_line(&device_id, endpoints)
        });
        for snapshot in snapshots {
            let _ = tx.send(Message::Text(snapshot));
        }
        true
    }

    pub fn update_host(
        &self,
        device_id: &str,
        endpoint_id: &str,
        conn_id: u64,
        update: EndpointUpdate,
    ) -> bool {
        let key = (device_id.to_owned(), endpoint_id.to_owned());
        let notifications = {
            let mut inner = self.lock();
            let previous = match inner.endpoints.get(&key) {
                Some(host) if host.conn_id == conn_id => HostSnapshot::from(host),
                _ => return false,
            };
            let Some(host) = inner.endpoints.get_mut(&key) else {
                return false;
            };
            if let Some(metadata) = update.metadata {
                host.metadata = metadata;
            }
            if let Some(authorized_owner_ids) = update.authorized_owner_ids {
                host.authorized_owner_ids = authorized_owner_ids;
            }
            let current = inner.endpoints.get(&key);
            Self::visibility_delta_from_snapshot(&inner, &key, Some(&previous), current)
        };
        send_notifications(notifications);
        true
    }

    pub fn is_active_host(&self, device_id: &str, endpoint_id: &str, conn_id: u64) -> bool {
        self.lock()
            .endpoints
            .get(&(device_id.to_owned(), endpoint_id.to_owned()))
            .is_some_and(|host| host.conn_id == conn_id)
    }

    pub fn route_from_owner(
        &self,
        owner_id: &str,
        conn_id: u64,
        route: RouteFrame,
    ) -> RouteOutcome {
        if route.target_owner_id.is_some() || route.source_owner_id.is_some() {
            return RouteOutcome::Unauthorized;
        }

        let inner = self.lock();
        if !inner
            .owners
            .get(owner_id)
            .is_some_and(|connections| connections.contains_key(&conn_id))
        {
            return RouteOutcome::Stale;
        }
        let key = (route.device_id.clone(), route.endpoint_id.clone());
        let Some(host) = inner.endpoints.get(&key) else {
            return RouteOutcome::Unavailable;
        };
        if host.runtime_instance_id != route.runtime_instance_id {
            return RouteOutcome::Stale;
        }
        if route.purpose == RoutePurpose::Session && !host.authorized_owner_ids.contains(owner_id) {
            return RouteOutcome::Unauthorized;
        }
        let mut forwarded = route;
        forwarded.source_owner_id = Some(owner_id.to_owned());
        let Some(line) = serialize_route(&forwarded) else {
            return RouteOutcome::Unavailable;
        };
        if host.tx.send(Message::Text(line)).is_ok() {
            RouteOutcome::Delivered
        } else {
            RouteOutcome::Unavailable
        }
    }

    pub fn route_from_host(
        &self,
        device_id: &str,
        endpoint_id: &str,
        conn_id: u64,
        route: RouteFrame,
    ) -> RouteOutcome {
        let Some(target_owner_id) = route.target_owner_id.as_deref() else {
            return RouteOutcome::Unauthorized;
        };
        let inner = self.lock();
        let key = (device_id.to_owned(), endpoint_id.to_owned());
        let Some(host) = inner.endpoints.get(&key) else {
            return RouteOutcome::Stale;
        };
        if host.conn_id != conn_id
            || route.device_id != device_id
            || route.endpoint_id != endpoint_id
            || route.runtime_instance_id != host.runtime_instance_id
            || route.source_owner_id.is_some()
        {
            return RouteOutcome::Stale;
        }
        if route.purpose == RoutePurpose::Session
            && !host.authorized_owner_ids.contains(target_owner_id)
        {
            return RouteOutcome::Unauthorized;
        }
        let Some(owners) = inner.owners.get(target_owner_id) else {
            return RouteOutcome::Unavailable;
        };
        let Some(line) = serialize_route(&route) else {
            return RouteOutcome::Unavailable;
        };
        let message = Message::Text(line);
        let mut delivered = false;
        for owner in owners.values() {
            if owner.tx.send(message.clone()).is_ok() {
                delivered = true;
            }
        }
        if delivered {
            RouteOutcome::Delivered
        } else {
            RouteOutcome::Unavailable
        }
    }

    fn visibility_delta(
        inner: &RegistryInner,
        key: &EndpointKey,
        previous: Option<&HostConnection>,
        current: Option<&HostConnection>,
    ) -> Vec<(Outbound, String)> {
        Self::visibility_delta_with(inner, key, previous.map(HostSnapshot::from), current)
    }

    fn visibility_delta_from_snapshot(
        inner: &RegistryInner,
        key: &EndpointKey,
        previous: Option<&HostSnapshot>,
        current: Option<&HostConnection>,
    ) -> Vec<(Outbound, String)> {
        Self::visibility_delta_with(inner, key, previous.cloned(), current)
    }

    fn visibility_delta_with(
        inner: &RegistryInner,
        key: &EndpointKey,
        previous: Option<HostSnapshot>,
        current: Option<&HostConnection>,
    ) -> Vec<(Outbound, String)> {
        let previous_info = previous.as_ref().map(|host| host.endpoint_info(&key.1));
        let current_info = current.map(|host| endpoint_info(host, &key.1));
        let announced = current_info
            .as_ref()
            .and_then(|endpoint| endpoint_announced_line(&key.0, endpoint));
        let updated = current_info
            .as_ref()
            .and_then(|endpoint| endpoint_updated_line(&key.0, endpoint));
        let ended = previous_info
            .as_ref()
            .and_then(|endpoint| endpoint_ended_line(&key.0, endpoint));

        let mut notifications = Vec::new();
        for (owner_id, connections) in &inner.owners {
            let was_authorized = previous
                .as_ref()
                .is_some_and(|host| host.authorized_owner_ids.contains(owner_id));
            let is_authorized =
                current.is_some_and(|host| host.authorized_owner_ids.contains(owner_id));
            let line = match (was_authorized, is_authorized) {
                (false, true) => announced.as_ref(),
                (true, true) => updated.as_ref(),
                (true, false) => ended.as_ref(),
                (false, false) => None,
            };
            let Some(line) = line else {
                continue;
            };
            for owner in connections.values() {
                if owner.subscribed_device_ids.contains(&key.0) {
                    notifications.push((owner.tx.clone(), line.clone()));
                }
            }
        }
        notifications
    }

    fn lock(&self) -> MutexGuard<'_, RegistryInner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("endpoint registry mutex poisoned; continuing with recovered state");
                poisoned.into_inner()
            }
        }
    }
}

#[derive(Debug, Clone)]
struct HostSnapshot {
    runtime_instance_id: String,
    metadata: crate::protocol::outer::EndpointMetadata,
    authorized_owner_ids: HashSet<String>,
}

impl From<&HostConnection> for HostSnapshot {
    fn from(host: &HostConnection) -> Self {
        Self {
            runtime_instance_id: host.runtime_instance_id.clone(),
            metadata: host.metadata.clone(),
            authorized_owner_ids: host.authorized_owner_ids.clone(),
        }
    }
}

impl HostSnapshot {
    fn endpoint_info(&self, endpoint_id: &str) -> EndpointInfo {
        EndpointInfo {
            endpoint_id: endpoint_id.to_owned(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

fn endpoint_info(host: &HostConnection, endpoint_id: &str) -> EndpointInfo {
    EndpointInfo {
        endpoint_id: endpoint_id.to_owned(),
        runtime_instance_id: host.runtime_instance_id.clone(),
        metadata: host.metadata.clone(),
    }
}

fn serialize_route(route: &RouteFrame) -> Option<String> {
    serde_json::to_string(route).ok()
}

fn send_notifications(notifications: Vec<(Outbound, String)>) {
    for (tx, line) in notifications {
        let _ = tx.send(Message::Text(line));
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use tokio::sync::mpsc;

    use super::*;
    use crate::protocol::outer::{EndpointKind, EndpointMetadata};

    const ENDPOINT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const RUNTIME_A: &str = "22222222-2222-4222-8222-222222222222";
    const RUNTIME_B: &str = "33333333-3333-4333-8333-333333333333";

    fn id(byte: u8) -> String {
        STANDARD.encode([byte; 32])
    }

    fn host(device_id: String, runtime_instance_id: &str, owners: &[String]) -> HostHello {
        HostHello {
            device_id,
            endpoint_id: ENDPOINT_ID.to_owned(),
            runtime_instance_id: runtime_instance_id.to_owned(),
            metadata: EndpointMetadata {
                kind: EndpointKind::Daemon,
                name: None,
                cwd: None,
                pid: None,
                started_at: None,
                model: None,
                thinking: None,
                working: None,
            },
            authorized_owner_ids: owners.iter().cloned().collect(),
        }
    }

    fn route(device_id: String, runtime_instance_id: &str, purpose: RoutePurpose) -> RouteFrame {
        RouteFrame {
            frame_type: "route".to_owned(),
            purpose,
            device_id,
            endpoint_id: ENDPOINT_ID.to_owned(),
            runtime_instance_id: runtime_instance_id.to_owned(),
            target_owner_id: None,
            source_owner_id: None,
            ct: "opaque payload".to_owned(),
        }
    }

    #[test]
    fn takeover_makes_the_old_runtime_stale() {
        let registry = PeerRegistry::new();
        let device = id(1);
        let owner = id(2);
        let (owner_tx, mut owner_rx) = mpsc::unbounded_channel();
        let owner_conn = registry.register_owner(owner.clone(), owner_tx);
        assert!(registry.subscribe_endpoints(&owner, owner_conn, vec![device.clone()]));
        let _ = owner_rx.try_recv();

        let (host_a_tx, mut host_a_rx) = mpsc::unbounded_channel();
        let host_a_conn =
            registry.register_host(host(device.clone(), RUNTIME_A, &[owner.clone()]), host_a_tx);
        let _ = owner_rx.try_recv();
        assert_eq!(
            registry.route_from_owner(
                &owner,
                owner_conn,
                route(device.clone(), RUNTIME_A, RoutePurpose::Session)
            ),
            RouteOutcome::Delivered
        );
        assert!(host_a_rx.try_recv().is_ok());

        let (host_b_tx, mut host_b_rx) = mpsc::unbounded_channel();
        let _host_b_conn =
            registry.register_host(host(device.clone(), RUNTIME_B, &[owner.clone()]), host_b_tx);
        let update = owner_rx.try_recv().unwrap();
        assert!(update.to_text().unwrap().contains(RUNTIME_B));

        let mut stale_host_route = route(device.clone(), RUNTIME_A, RoutePurpose::Session);
        stale_host_route.target_owner_id = Some(owner.clone());
        assert_eq!(
            registry.route_from_host(&device, ENDPOINT_ID, host_a_conn, stale_host_route),
            RouteOutcome::Stale
        );
        assert!(owner_rx.try_recv().is_err());

        assert_eq!(
            registry.route_from_owner(
                &owner,
                owner_conn,
                route(device.clone(), RUNTIME_A, RoutePurpose::Session)
            ),
            RouteOutcome::Stale
        );
        assert!(host_a_rx.try_recv().is_err());
        assert_eq!(
            registry.route_from_owner(
                &owner,
                owner_conn,
                route(device, RUNTIME_B, RoutePurpose::Session)
            ),
            RouteOutcome::Delivered
        );
        assert!(host_b_rx.try_recv().is_ok());
        assert!(!registry.is_active_host(&id(1), ENDPOINT_ID, host_a_conn));
    }

    #[test]
    fn session_routes_require_acl_but_pairing_does_not() {
        let registry = PeerRegistry::new();
        let device = id(3);
        let owner = id(4);
        let (owner_tx, _) = mpsc::unbounded_channel();
        let owner_conn = registry.register_owner(owner.clone(), owner_tx);
        let (host_tx, mut host_rx) = mpsc::unbounded_channel();
        registry.register_host(host(device.clone(), RUNTIME_A, &[]), host_tx);

        assert_eq!(
            registry.route_from_owner(
                &owner,
                owner_conn,
                route(device.clone(), RUNTIME_A, RoutePurpose::Session)
            ),
            RouteOutcome::Unauthorized
        );
        assert_eq!(
            registry.route_from_owner(
                &owner,
                owner_conn,
                route(device, RUNTIME_A, RoutePurpose::Pairing)
            ),
            RouteOutcome::Delivered
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                host_rx.try_recv().unwrap().to_text().unwrap()
            )
            .unwrap()["ct"],
            "opaque payload"
        );
    }
}
