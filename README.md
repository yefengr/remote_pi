<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

<p align="center">
  Control your <a href="https://github.com/earendil-works/pi">Pi coding agent</a> from a browser.
  Open the Remote Pi PWA, pair with a one-time QR code, and chat with your local agent — even when you're away from your computer.
</p>

---

## Links

- **Official site** — <https://remote-pi.jacobmoura.work>
- **Package documentation** — <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** — <https://github.com/jacobaraujo7/remote_pi>

### Browser app

Open the [Remote Pi PWA](https://remote-pi.jacobmoura.work/app) in a modern browser. It can be installed as a standalone app and keeps pairing records in the browser profile.

## What's in this repo

| Package | Stack | Role |
|---|---|---|
| [`pi-extension/`](./pi-extension) | Node + TypeScript | Pi extension exposing `/remote-pi`, Daemon, and Agent Mesh |
| [`relay/`](./relay) | Rust + Tokio | WebSocket routing, Rooms, and signed mesh membership storage |
| [`site/`](./site) | NextJS | Landing page, docs, legal pages, and PWA |

## Architecture

```
Browser PWA ──wss──► Relay (Rust) ◄──wss── Pi extension (Node)
                                              │                 │
                                   Rooms + cross-PC mesh   Pi process
                                                                │
                                                         UDS broker
                                                                │
                                                        Other agents
```

- **Pairing** via short-lived QR code; the PWA stores its Owner identity and pairing records in the browser profile, while the extension persists host state in `~/.pi/remote/`
- **Ed25519 authentication** — the Relay handshake proves possession of the connection key; PWA↔Pi pairing is enforced by the endpoints. For Pi↔Pi routing, the current Relay permits a route when a correctly signed Owner blob lists both Pi keys; that check does not prove the Owner paired with or controls either Pi
- **TLS protects traffic in transit**, but current payloads are not E2E; see [`relay/README.md`](./relay/README.md) for the exact trust boundary

## Local agent mesh

When multiple Pi agents run on the same machine, they discover each other through
a **Unix Domain Socket broker** managed by the extension. One agent wins the
leader election and binds the socket; the others connect as clients. For targets
on that same machine, agents use the opaque addresses returned by `list_peers` —
no relay, no network, no extra config.

Three LLM-facing tools are exposed in the Pi chat:

- `list_peers` — lists local and cross-PC addresses available to the agent
- `agent_send` — sends a unicast message and waits for a delivery ACK. Compatible ACK values are `received`, `busy`, `denied`, and `timeout`; current brokers return `received`, `denied`, or `timeout`, while `busy` only indicates a dropped message from an old broker leader that must be restarted before resending. Broadcast is `sent` with no ACK. Asynchronous content replies use `re`
- `agent_request` — request/response with timeout, available only as deprecated legacy behavior

This lets you set up local multi-agent workflows (e.g. a `backend` agent asks a
`frontend` agent for help) entirely on your machine, in parallel with PWA remote
control.

## Relay

A free community relay is available at:

```
wss://relay-rp1.jacobmoura.work
```

It's enough to get started, but the relay operator can see the content of your
messages and is a single point of trust for routing. **For sensitive work, we
strongly recommend running your own relay** — it's a single Docker command and
the only thing your traffic ever touches is your own infrastructure.

Full security trade-offs and the self-hosting guide live in
**[`relay/README.md`](./relay/README.md)**.

## Getting started

Install the Pi extension in any project where Pi runs:

```bash
pi install npm:@yefengr/remote-pi
```

Then in the Pi chat, run:

```
/remote-pi
```

The setup wizard walks you through agent name, session name, and relay choice,
then prints a QR code. Open the [Remote Pi PWA](https://remote-pi.jacobmoura.work/app),
scan it, and you're paired.

### Recommended companion: `@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

With pi-ask installed, the agent's `ask_user` clarification prompts (structured
questions with options, multi-select, and previews) render in the PWA — answer
from your browser and the flow resolves on the desktop. Without it, the agent
simply asks in plain chat text (also answerable from the browser, just
unstructured). Remote Pi works either way; pi-ask is optional.

## Status

The MVP is functional. Planning notes and roadmap live in [`plan/`](./plan).

## License

License is per-package — see each subproject's `LICENSE` file (the `pi-extension`
is MIT). A repository-wide license decision is pending.
