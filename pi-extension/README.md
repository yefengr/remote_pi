<p align="center">
  <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="160" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

> A Pi extension for browser control of local Pi endpoints, with an optional supervised daemon lifecycle.

**Homepage:** <https://remote-pi.jacobmoura.work>

`/remote-pi` connects the current Pi endpoint to a Relay and provides pairing for the Remote Pi PWA. The browser selects endpoint cards, sends prompts, receives a live timeline, and can request a small set of typed session actions.

## Endpoint model

Remote Pi addresses process state as:

```text
device → endpoint → runtime → session / history generation
```

- **Device**: a computer identity.
- **Endpoint**: a stable interactive or daemon target. A working directory may host more than one endpoint.
- **Runtime**: the current process instance for an endpoint. A daemon restart keeps the endpoint and starts a new runtime.
- **Session / generation**: the currently live Pi conversation and its history branch. The PWA does not list or resume historical Pi sessions.

The pairing QR is endpoint- and runtime-aware. Pair every computer independently, and revoke pairings independently on each computer. The PWA can retain multiple devices and multiple endpoint cards for each device.

## Quick start

Install once in any project where Pi runs:

```bash
pi install npm:@yefengr/remote-pi
```

Then in Pi:

```text
/remote-pi
/remote-pi pair
```

The first run creates a per-folder endpoint configuration and connects to the configured Relay. The QR command prints a one-time URI. Scan it in the [Remote Pi PWA](https://remote-pi.jacobmoura.work/app), select the endpoint card, and send a prompt.

Pairings are local to the computer that creates them:

```text
/remote-pi devices
/remote-pi revoke <shortid>
```

## Browser session actions

The PWA supports normal chat plus typed actions that Pi can apply directly:

| Action | Effect |
|---|---|
| Compact context | Calls `ctx.compact()` |
| New session | Calls `ctx.newSession()` after confirmation |
| Model | Uses `pi.setModel(model)` |
| Thinking | Uses `pi.setThinkingLevel(level)` |

The model picker reflects the providers configured on the host. Pi settings are the only extension source used by the supervisor and interactive Pi; Remote Pi does not inject an additional extension argument when starting Pi.

An optional companion adds rich remote clarification prompts:

```bash
pi install npm:@eko24ive/pi-ask
```

## Relay configuration

The effective Relay URL resolves in this order:

1. `REMOTE_PI_RELAY`
2. `~/.pi/remote/config.json`
3. `https://relay-pi.yefengr.cn`

Set and inspect it from Pi:

```text
/remote-pi set-relay https://relay.example.com
/remote-pi config
```

Only `http://` and `https://` are accepted at the command boundary; WebSocket conversion happens internally. The Relay keeps endpoint routing state in memory and forwards opaque `ct` payloads. See [`../relay/README.md`](../relay/README.md) for its operational and security boundary.

## Commands

| Command | Description |
|---|---|
| `/remote-pi` | Connect the current endpoint; first use creates local configuration |
| `/remote-pi start` / `/remote-pi stop` | Connect or disconnect this endpoint |
| `/remote-pi status` | Show Relay, endpoint, and runtime state |
| `/remote-pi pair` | Show an endpoint- and runtime-aware pairing QR |
| `/remote-pi devices` | List pairings stored on this computer |
| `/remote-pi revoke <shortid>` | Revoke one locally stored pairing |
| `/remote-pi set-relay <url>` | Persist the Relay URL |
| `/remote-pi config` | Show the resolved Relay URL |
| `/remote-pi create <cwd>` | Explicitly register a daemon with desired state `running` |
| `/remote-pi remove <id>` | Unregister a daemon by identifier |
| `/remote-pi remove-cwd <cwd>` | Idempotently unregister a daemon by working directory |
| `/remote-pi daemons` | List registered daemons |
| `/remote-pi daemon start\|stop\|restart [id]` | Change the desired lifecycle for one daemon or the fleet |
| `/remote-pi daemon status` | Show orthogonal daemon lifecycle state |
| `/remote-pi install` / `/remote-pi uninstall` | Install or remove the user-level supervisor service |

The global `remote-pi` CLI exposes the same lifecycle commands after installation. The cwd-based removal command is intended for external worktree managers as well as manual cleanup.

## Daemon mode

Daemon mode is an explicit opt-in:

```bash
npm install -g @yefengr/remote-pi
remote-pi install
remote-pi create ~/Projects/backend
remote-pi daemon status
```

The v2 registry at `~/.pi/remote/daemons.json` stores an opaque daemon identifier, canonical cwd, display name, creation time, and desired lifecycle (`running` or `stopped`). Registration starts in `running`; a live supervisor starts it immediately. On supervisor startup, only registrations whose desired lifecycle is `running` are restored.

The supervisor starts Pi in RPC mode without an extra extension argument. Pi's own settings determine extension loading and model/provider configuration. A daemon runtime inherits its registered endpoint identity, while every spawn receives a fresh runtime identity.

### Lifecycle and health

`daemon status` keeps these dimensions separate:

| Dimension | Meaning |
|---|---|
| registration | Registered or missing working directory |
| desired | Persisted `running` or `stopped` intent |
| process | OS child absent, spawning, running, or exited |
| runtime | RPC pending, ready, or failed |
| relay | Disconnected, connecting, connected, or reconnecting |
| health | Stopped, starting, healthy, degraded, failed, or blocked |

A ready daemon reconnecting to the Relay is **degraded**, not restarted. Non-retryable configuration and startup failures become deterministic **blocked** errors. If a cwd disappears, dispatch is denied immediately and the supervisor reconciles the stale registration after confirmation.

### Scheduled prompts

Cron owns no daemon lifecycle. A scheduled prompt is sent only when its daemon is desired `running` and its runtime is ready; otherwise it is skipped and audited. There is no wake behavior.

```bash
remote-pi cron add <daemon-id> "0 9 * * 1-5" "Summarize the new PRs" --tz America/Sao_Paulo
remote-pi cron list
remote-pi cron log --tail 20
```

Runs are at least 60 seconds apart. `--no-skip-busy` permits dispatch during a running turn; `--catchup` permits one missed run after supervisor startup. Audits distinguish accepted, rejected, busy, desired-stopped, starting, retrying, failed, blocked, missing, and disabled outcomes.

## Troubleshooting

For daemon service installation, status interpretation, stale cwd cleanup, and recovery steps, see [`docs/daemon.md`](./docs/daemon.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 20+ and TypeScript ESM are required. Use `.js` extensions in TypeScript imports.

## License

MIT
