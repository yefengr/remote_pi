import type { Metadata } from "next";
import Link from "next/link";
import { DocsSection, DocsSubsection, DocsTable, InlineCode } from "@/components/docs-shell";
import { CodeBlock } from "@/components/code-block";
import { DocsToc, type TocItem } from "@/components/docs-toc";
import { RevealController } from "@/components/landing/reveal-controller";

export const metadata: Metadata = {
  title: "Docs",
  description: "Reference for Remote Pi endpoint pairing, browser control, Relay configuration, and daemon lifecycle.",
};

const GITHUB_URL = "https://github.com/jacobaraujo7/remote_pi";
const PI_URL = "https://github.com/earendil-works/pi";
const RELAY_README_URL = "https://github.com/jacobaraujo7/remote_pi/blob/main/relay/README.md";

const DOCS_TOC: TocItem[] = [
  { id: "quick-start", label: "Quick start" },
  { id: "endpoint-model", label: "Endpoint model" },
  { id: "pairing", label: "Pairing and PWA" },
  { id: "quick-actions", label: "Browser actions" },
  { id: "daemon-mode", label: "Daemon mode" },
  { id: "relay", label: "Relay" },
  { id: "commands", label: "Commands" },
  { id: "config", label: "Configuration" },
  { id: "security", label: "Security" },
  { id: "links", label: "Links" },
];

export default function DocsPage() {
  return (
    <div className="page">
      <div className="page-body">
        <div className="wrap">
          <header className="page-head reveal">
            <span className="eyebrow">Documentation</span>
            <h1>Remote Pi docs</h1>
            <div className="meta-line"><span>Last updated: 2026-08-28</span><span>License: MIT</span></div>
            <p className="lede">
              Remote Pi connects the <strong className="text-fg">browser PWA</strong> to
              reachable Pi endpoints through a Relay. Pair each computer independently,
              select an endpoint card, and control its current Pi runtime from the browser.
              For the guided path, start with the <Link href="/tutorials" className="text-accent underline">tutorials</Link>.
            </p>
          </header>

          <div className="docs-layout">
            <DocsToc items={DOCS_TOC} />
            <article className="prose docs-article">
              <DocsSection id="quick-start" title="Quick start">
                <p>Install the extension in a project where Pi runs, connect its current endpoint, then pair the browser PWA with a one-time QR code.</p>
                <CodeBlock code={`pi install npm:@yefengr/remote-pi\n# In Pi:\n/remote-pi\n/remote-pi pair`} label="Install and pair" language="text" />
                <p>Open <Link href="/app" className="text-accent underline">the PWA</Link>, scan the QR, choose the endpoint card, and send a prompt.</p>
              </DocsSection>

              <DocsSection id="endpoint-model" title="Endpoint model">
                <p>Remote Pi tracks a live target through four scopes:</p>
                <CodeBlock code="device → endpoint → runtime → session / history generation" label="Identity hierarchy" language="text" />
                <ul className="ml-6 list-disc space-y-2">
                  <li><strong className="text-fg">Device</strong> is one computer identity.</li>
                  <li><strong className="text-fg">Endpoint</strong> is a stable interactive or daemon target. One cwd may have multiple endpoints.</li>
                  <li><strong className="text-fg">Runtime</strong> is the current process instance. Restarting a daemon preserves its endpoint and creates a new runtime.</li>
                  <li><strong className="text-fg">Session / generation</strong> is the current Pi conversation and branch. Remote Pi does not expose a historical Pi-session list or resume flow.</li>
                </ul>
              </DocsSection>

              <DocsSection id="pairing" title="Pairing and browser PWA">
                <p>The pairing QR names the endpoint and runtime it was created for. Pair every computer separately; a revoke on one computer affects only that computer&apos;s stored pairing.</p>
                <DocsTable headers={["Command", "Description"]} rows={[
                  [<InlineCode key="pair">/remote-pi pair</InlineCode>, "Show a one-time endpoint- and runtime-aware QR"],
                  [<InlineCode key="devices">/remote-pi devices</InlineCode>, "List pairings stored on this computer"],
                  [<InlineCode key="revoke">/remote-pi revoke &lt;shortid&gt;</InlineCode>, "Revoke one local device pairing"],
                ]} />
                <p>The PWA persists an owner key, paired device records, endpoint cards, and endpoint-scoped timelines in its local browser workspace. It can show multiple devices and multiple endpoints per device.</p>
              </DocsSection>

              <DocsSection id="quick-actions" title="Browser actions">
                <p>Alongside chat, the PWA can ask the live endpoint to compact context, start a new session, set a model, or set a thinking level. The model picker reads the host&apos;s configured providers, and Pi settings remain the only source for extension loading and Pi configuration.</p>
              </DocsSection>

              <DocsSection id="daemon-mode" title="Daemon mode">
                <p>Daemon mode is an explicit opt-in. A user-level supervisor manages registered endpoints on one computer.</p>
                <CodeBlock code={`npm install -g @yefengr/remote-pi\nremote-pi install\nremote-pi create ~/Projects/backend\nremote-pi daemon status`} label="Shell" language="bash" />
                <p>The registry v2 persists desired <InlineCode>running</InlineCode> or <InlineCode>stopped</InlineCode> state. On supervisor startup, only desired-running registrations are restored. The supervisor starts Pi without an extra extension argument, so Pi settings are the sole extension source.</p>
                <p>Status separates registration, desired lifecycle, OS process, runtime readiness, Relay state, and derived health. A Relay reconnect makes a ready endpoint degraded; it does not restart Pi. Deterministic failures are reported as blocked errors, and deleted cwds are reconciled as stale registrations.</p>
                <p>See the <Link href="/tutorials/daemon" className="text-accent underline">Daemon mode tutorial</Link> for lifecycle operations and scheduled prompts.</p>
              </DocsSection>

              <DocsSection id="relay" title="Relay">
                <p>The Relay authenticates connections, announces endpoints to paired browser devices, and routes opaque <InlineCode>ct</InlineCode> containers. Its endpoint registry exists only in memory: no endpoint inventory, pairing history, or message traffic is persisted by the Relay.</p>
                <DocsSubsection title="Use the community Relay">
                  <p><InlineCode>https://relay-pi.yefengr.cn</InlineCode> is the default. The extension and PWA accept HTTP(S) configuration and convert it internally for the WebSocket connection.</p>
                </DocsSubsection>
                <DocsSubsection title="Self-host">
                  <CodeBlock code={`docker run -d \\\n  --name remote-pi-relay \\\n  -p 3000:3000 \\\n  --restart unless-stopped \\\n  jacobmoura7/remote-pi-relay`} label="Relay host" language="bash" />
                  <p>The Relay serves its WebSocket endpoint at <InlineCode>/</InlineCode> and liveness at <InlineCode>/health</InlineCode>. It has no persistent state to mount.</p>
                </DocsSubsection>
              </DocsSection>

              <DocsSection id="commands" title="Command reference">
                <DocsTable headers={["Command", "Description"]} rows={[
                  [<InlineCode key="start">/remote-pi [start]</InlineCode>, "Connect the current Pi endpoint; first use creates local configuration"],
                  [<InlineCode key="stop">/remote-pi stop</InlineCode>, "Disconnect this endpoint from the Relay"],
                  [<InlineCode key="status">/remote-pi status</InlineCode>, "Show Relay, endpoint, and runtime state"],
                  [<InlineCode key="paircmd">/remote-pi pair</InlineCode>, "Show a pairing QR"],
                  [<InlineCode key="relay">/remote-pi set-relay &lt;url&gt;</InlineCode>, "Persist an HTTP(S) Relay URL"],
                  [<InlineCode key="create">remote-pi create &lt;cwd&gt;</InlineCode>, "Register a daemon with desired state running"],
                  [<InlineCode key="daemon">remote-pi daemon start|stop|restart [id]</InlineCode>, "Set daemon desired lifecycle"],
                  [<InlineCode key="daemonstatus">remote-pi daemon status</InlineCode>, "Show detailed daemon lifecycle status"],
                  [<InlineCode key="remove">remote-pi remove &lt;id&gt;</InlineCode>, "Unregister one daemon"],
                  [<InlineCode key="removecwd">remote-pi remove-cwd &lt;cwd&gt;</InlineCode>, "Idempotently unregister a daemon by cwd"],
                ]} />
                <p><InlineCode>remote-pi cron</InlineCode> schedules delivery only. A job dispatches only when its daemon is desired running and runtime ready; all other outcomes are skipped and audited. There is no lifecycle-start behavior in cron.</p>
              </DocsSection>

              <DocsSection id="config" title="Configuration">
                <DocsTable headers={["Path", "Scope", "Contents"]} rows={[
                  [<InlineCode key="local">&lt;cwd&gt;/.pi/remote-pi/config.json</InlineCode>, "Per endpoint", "Display name and Relay auto-start preference"],
                  [<InlineCode key="relayconfig">~/.pi/remote/config.json</InlineCode>, "Per user", "Relay URL"],
                  [<InlineCode key="peers">~/.pi/remote/peers.json</InlineCode>, "Per computer", "Locally paired PWA owners"],
                  [<InlineCode key="daemons">~/.pi/remote/daemons.json</InlineCode>, "Per computer", "v2 daemon registrations and desired lifecycle"],
                  [<InlineCode key="cron">~/.pi/remote/cron.jsonl</InlineCode>, "Per computer", "Scheduled-prompt audit log"],
                ]} />
                <p>Relay resolution order is <InlineCode>REMOTE_PI_RELAY</InlineCode>, then <InlineCode>~/.pi/remote/config.json</InlineCode>, then the community default.</p>
              </DocsSection>

              <DocsSection id="security" title="Security">
                <p>Relay connections use Ed25519 authentication and should use TLS. The shipped Relay forwards opaque <InlineCode>ct</InlineCode> payloads without decoding, logging, or persisting their contents. An operator who controls the Relay executable or TLS endpoint remains in the trust path; self-host for sensitive work.</p>
              </DocsSection>

              <DocsSection id="links" title="Links">
                <ul className="ml-6 list-disc space-y-2">
                  <li><a className="text-accent underline" href={PI_URL} target="_blank" rel="noopener noreferrer">Pi coding agent</a></li>
                  <li><a className="text-accent underline" href={RELAY_README_URL} target="_blank" rel="noopener noreferrer">Relay self-hosting guide</a></li>
                  <li><a className="text-accent underline" href={`${GITHUB_URL}/blob/main/pi-extension/docs/daemon.md`} target="_blank" rel="noopener noreferrer">Daemon operations guide</a></li>
                </ul>
              </DocsSection>
            </article>
          </div>
        </div>
      </div>
      <RevealController />
    </div>
  );
}
