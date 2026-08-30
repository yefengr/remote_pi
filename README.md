<p align="center">
  <img src="branding/logo-full.svg" width="140" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

<p align="center">
  Control Pi coding-agent endpoints from a browser. Pair the PWA with a one-time QR code, choose an endpoint card, and keep working from anywhere.
</p>

---

## Links

- **Official site** — <https://remote-pi.jacobmoura.work>
- **Package documentation** — <https://pi.dev/packages/remote-pi?name=remote-pi>
- **GitHub** — <https://github.com/jacobaraujo7/remote_pi>

## What is in this repository

| Package | Stack | Role |
|---|---|---|
| [`pi-extension/`](./pi-extension) | Node + TypeScript | Pi extension, endpoint pairing, and daemon supervisor CLI |
| [`relay/`](./relay) | Rust + Tokio | WebSocket relay with an in-memory endpoint registry |
| [`site/`](./site) | NextJS | Landing pages, documentation, legal pages, and browser PWA |

## Architecture

```text
Browser PWA ──wss──► Relay ──wss──► Pi endpoint
                                      │
                                 Pi runtime/session
```

Remote Pi identifies a reachable process as:

```text
device → endpoint → runtime → session / history generation
```

- A **device** is one computer identity.
- An **endpoint** is a stable interactive or daemon target on that device. The same working directory may have multiple endpoints.
- A **runtime** is one process instance. Restarting a daemon preserves its endpoint and creates a new runtime.
- A browser card selects an endpoint; its timeline is scoped to its session and history generation. Remote Pi does not provide a historical Pi-session browser or a resume list.

The Relay authenticates connections and keeps its endpoint registry only in memory. It forwards opaque `ct` payloads and enforces the device ACL supplied by pairing; it does not persist message traffic or endpoint records. TLS protects the transport. Run a relay you trust for sensitive work; see [`relay/README.md`](./relay/README.md).

## Pairing and browser control

Open the [Remote Pi PWA](https://remote-pi.jacobmoura.work/app) in a modern browser. It can be installed as a standalone app and keeps local workspace data in that browser profile.

Pair each computer separately:

1. Install the extension in a project where Pi runs.
2. Run `/remote-pi`, then `/remote-pi pair`.
3. Scan the endpoint- and runtime-aware QR with the PWA.

The PWA can hold multiple device records and multiple endpoint cards per device. Use `/remote-pi devices` to inspect local pairings and `/remote-pi revoke <shortid>` to revoke one device pairing on that computer.

## Getting started

```bash
pi install npm:@yefengr/remote-pi
```

Then, in Pi:

```text
/remote-pi
/remote-pi pair
```

The first command creates the local endpoint configuration and connects it to the configured Relay. The second prints a one-time pairing QR. Open the PWA, scan it, select the new endpoint card, and send a prompt.

The browser can also request compact context, create a new session, change model, and change thinking level. Pi settings remain the source of truth for extension loading and model configuration.

### Optional companion: `@eko24ive/pi-ask`

```bash
pi install npm:@eko24ive/pi-ask
```

With pi-ask installed, structured `ask_user` prompts render in the PWA. Without it, ordinary text prompts continue to work.

## Daemon mode

Daemon mode is an explicit opt-in. Install the supervisor once per computer, then register only folders that should be managed:

```bash
npm install -g @yefengr/remote-pi
remote-pi install
remote-pi create ~/Projects/backend
remote-pi daemon status
```

The registry is version 2 and persists each daemon's desired state (`running` or `stopped`). On startup the supervisor restores only registrations whose desired state is `running`; stopped registrations stay stopped. A missing working directory is reconciled as stale rather than spawned.

Status reports registration, desired lifecycle, OS process, runtime readiness, Relay state, and derived health separately. A Relay reconnect makes an otherwise ready daemon degraded; it does not restart Pi. Deterministic configuration or startup failures are shown as blocked errors instead of being retried forever.

Use `remote-pi remove-cwd <cwd>` for idempotent cwd-based unregistration, including external worktree cleanup integrations. See [`pi-extension/docs/daemon.md`](./pi-extension/docs/daemon.md) for operations and troubleshooting.

## Status

The project is actively evolving. Current architecture plans live in [`plan/`](./plan).

## License

License is per package — see each subproject's `LICENSE` file. The pi-extension is MIT.
