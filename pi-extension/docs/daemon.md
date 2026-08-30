# Daemon mode — operations and troubleshooting

Daemon mode is an explicit v2-registry opt-in for keeping selected Pi endpoints alive under one user-level supervisor. It is not part of ordinary interactive pairing.

Each registration has an opaque daemon/endpoint identifier, canonical cwd, display name, creation time, and persisted desired lifecycle:

```text
running | stopped
```

A daemon process is a runtime of that stable endpoint. Restarting the daemon creates a new runtime identity without changing the endpoint card selected by the PWA.

---

## Install the supervisor once per computer

```bash
npm install -g @yefengr/remote-pi
remote-pi install
```

`install` configures `launchd` on macOS or `systemd --user` on Linux, links `remote-pi` and `pi-supervisord`, and starts the service. The service reads the v2 registry from `~/.pi/remote/daemons.json`.

The supervisor launches Pi in RPC mode without passing an extra extension argument. Pi settings are the only source for extension loading, model selection, providers, and tool permissions. The supervisor does not import a private Pi SDK or repeat resource discovery out of process: the installed host Pi performs its own settings, package, resource, and diagnostic startup path. Correct Pi settings before registering an unattended daemon.

Runtime readiness requires both a successful host Pi RPC `get_state` response and the configured Remote Pi Extension's structured `runtime-ready` event with matching protocol and endpoint/runtime identities. In daemon RPC mode, lifecycle events use Pi's structured `extension_ui_request` status channel with the reserved `remote-pi:control` key; stderr remains diagnostic text and is never parsed as state. If RPC is ready but the Extension is missing or failed to load, the daemon becomes blocked with `extension_not_ready`; inspect the host Pi diagnostics in the supervisor log.

### Service does not start at login

Check the service first:

```bash
# Linux
systemctl --user status remote-pi-supervisord
journalctl --user -u remote-pi-supervisord -n 50

# macOS
launchctl list | grep remotepi
tail -100 ~/.pi/remote/supervisord.log
```

Common causes:

- **`pi: command not found`** — reinstall the service after fixing the PATH seen by the user service.
- **Missing compiled package files** — build a development clone or reinstall the global package, then run `remote-pi install` again.
- **Linux user service unavailable after logout** — enable lingering where required by the distribution: `loginctl enable-linger $USER`.

For foreground diagnosis, run `pi-supervisord` in a terminal and stop it with Ctrl-C when done.

---

## Register and control daemons

Registering is explicit and starts with desired state `running`:

```bash
remote-pi create ~/Projects/backend
remote-pi daemons
remote-pi daemon status
```

The supervisor starts the registration immediately when it is online. At a future supervisor start, it restores only registrations whose desired state remains `running`. A stopped registration remains stopped.

```bash
remote-pi daemon start <daemon-id>
remote-pi daemon stop <daemon-id>
remote-pi daemon restart <daemon-id>
remote-pi daemon start                 # every registration
remote-pi daemon stop                  # every registration
remote-pi daemon restart               # every registration
remote-pi remove <daemon-id>
remote-pi remove-cwd ~/Projects/backend
```

`remove-cwd <cwd>` is idempotent: it succeeds whether or not that cwd currently has a registration. It is safe for external worktree cleanup integrations.

The browser PWA may show multiple endpoints on the same computer. Pairing is independent for every computer, and revoking a pairing on one computer does not alter another computer's local pairing records.

---

## Read status as independent dimensions

Do not infer health from a single summary label. `remote-pi daemon status` reports:

| Field | Interpretation |
|---|---|
| registration | The persisted registration is present; a missing cwd is marked missing |
| desired | Persistent operator intent: `running` or `stopped` |
| process | OS child lifecycle: absent, spawning, running, or exited |
| runtime | RPC readiness: pending, ready, or failed |
| relay | Disconnected, connecting, connected, or reconnecting |
| health | Derived stopped, starting, healthy, degraded, failed, or blocked state |

A runtime can be ready while the Relay reconnects. That is a **degraded** state, not a reason to restart Pi. The runtime remains available locally and reconnects through its normal transport path.

A deterministic bad configuration, unsupported startup condition, or exhausted retry budget becomes **blocked**. Read `last_error_code`, `last_error_message`, and `startup_stage`, correct the cause, then explicitly start or restart the daemon. The supervisor does not loop forever on a blocked failure.

---

## Missing and moved working directories

The registry records the canonical cwd that existed at registration time. A daemon send to a missing cwd is denied immediately. The supervisor then reconciles stale registrations after bounded confirmation: it stops any child, removes the registration, and prevents later restoration.

If a project moved, register its new canonical cwd intentionally rather than editing the registry by hand:

```bash
remote-pi create /new/path/to/project
remote-pi remove-cwd /old/path/to/project
```

A corrupted or pre-v2 registry is an operator-visible error. It is never treated as an empty registry, because doing so could overwrite registrations. Replace the registry only after inspecting and backing up its contents.

---

## Scheduled prompts

Cron schedules prompt delivery; it never starts a daemon. A fire is accepted only when all of these are true:

1. The registration exists and its cwd is present.
2. Desired lifecycle is `running`.
3. The RPC runtime is ready.
4. The daemon is not busy, unless the job uses `--no-skip-busy`.

```bash
remote-pi cron add <daemon-id> "0 9 * * 1-5" "Summarize the new PRs" --tz America/Sao_Paulo
remote-pi cron list
remote-pi cron run <job-id>
remote-pi cron disable <job-id>
remote-pi cron log --tail 20
```

Schedules closer than 60 seconds are rejected. `--tz Area/City` uses a DST-aware timezone. `--catchup` allows one missed fire after supervisor startup. The cron audit at `~/.pi/remote/cron.jsonl` records every acceptance and skip, including desired-stopped, starting, retrying, failed, blocked, missing, disabled, busy, and rejected outcomes.

---

## Pairing and Relay diagnosis

Generate a fresh QR from an interactive endpoint:

```text
/remote-pi pair
/remote-pi devices
/remote-pi revoke <shortid>
```

The QR identifies the current endpoint and runtime. In the PWA, check that the expected device and endpoint card are selected. If a daemon was restarted, select its current runtime state and allow the endpoint to reconnect; a Relay reconnect should report degraded health rather than causing a Pi restart.

Confirm both sides use the same Relay URL:

```text
/remote-pi config
/remote-pi set-relay https://relay.example.com
```

After correcting a Relay URL, restart only the affected endpoint if it does not reconnect on its own.

---

## Logs and reset

| Platform | Command |
|---|---|
| Linux | `journalctl --user -u remote-pi-supervisord -f` |
| macOS | `tail -f ~/.pi/remote/supervisord.log` |

For a complete service reset:

```bash
remote-pi uninstall
npm uninstall -g @yefengr/remote-pi
npm install -g @yefengr/remote-pi
remote-pi install
```

Uninstalling the service preserves registrations. Remove individual registrations with `remote-pi remove` or `remote-pi remove-cwd`; do not delete registry state unless a deliberate full reset is required.
