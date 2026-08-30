# Remote Pi — Relay

A lightweight WebSocket relay between the Remote Pi browser PWA and Pi endpoints. It authenticates device connections, announces reachable endpoints to authorized browser devices, and forwards opaque payload containers.

For the product overview, see the [root README](../README.md).

---

## How it works

A connected computer announces one or more endpoints. Each endpoint has a stable endpoint identifier and a runtime identifier that changes whenever its Pi process starts again. Browser devices subscribe to paired computers and receive endpoint updates while they are connected.

The Relay keeps this routing authority **only in memory**:

- The registry is empty after a Relay restart; endpoints announce themselves again when they reconnect.
- No database, message store, pairing history, or endpoint inventory is written by the Relay.
- Route payloads use the `ct` container. The Relay does not decode its contents.
- A browser device can route a session payload only to an endpoint that authorizes that device. Pairing routes are allowed only for the endpoint/runtime named by the QR flow.
- A newer runtime for the same device and endpoint replaces the older connection atomically, so stale processes cannot publish or receive routes.

The Relay does not create pairings. Pairing keys and per-device authorization are maintained by the PWA and Pi extension.

## Security boundary

Connections use a challenge-response authentication handshake with Ed25519 keys and should use TLS in production.

The shipped service forwards opaque `ct` payloads without decoding, logging, or persisting their contents. This is an implementation boundary, not a guarantee against an operator who controls the Relay executable or TLS endpoint. For private code, credentials, or regulated data, self-host a Relay under infrastructure you control.

The Relay still handles connection metadata needed to operate WebSockets, including public-key identifiers, endpoint identifiers, timing, and transport sizes. Browser pairing controls which connected device may route to an endpoint; it is not an account system.

---

## Public Relay

A shared Relay is available at:

```text
https://relay-pi.yefengr.cn
```

The Pi extension and PWA accept an `http://` or `https://` Relay URL and convert it to the matching WebSocket scheme internally. Shared infrastructure is best-effort; use a Relay you trust for sensitive work.

## Self-hosting

### Docker

```bash
docker run -d \
  --name remote-pi-relay \
  -p 3000:3000 \
  --restart unless-stopped \
  jacobmoura7/remote-pi-relay
```

The Relay serves the WebSocket upgrade at `/` and a liveness response at `/health` on port `3000`. It has no persistent state to mount or back up.

Point both the browser PWA and the Pi extension to `http://<host>:3000`, or put the Relay behind a TLS-terminating proxy and use the proxy's `https://` URL.

### Reverse proxy

Example Caddy configuration:

```text
relay.example.com {
    reverse_proxy localhost:3000
}
```

Use `https://relay.example.com` in the PWA and with `/remote-pi set-relay https://relay.example.com`.

## Building from source

```bash
cargo build --release
./target/release/relay
```

## Tests

```bash
cargo test
cargo clippy -- -D warnings
```
