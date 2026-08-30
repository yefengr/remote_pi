import type { Metadata } from "next";
import Link from "next/link";
import { DocsSection, DocsSubsection, InlineCode } from "@/components/docs-shell";
import { CodeBlock } from "@/components/code-block";
import { Callout } from "@/components/callout";
import { Pager } from "@/components/pager";
import { RevealController } from "@/components/landing/reveal-controller";

export const metadata: Metadata = {
  title: "Daemon mode",
  description: "Opt into the Remote Pi supervisor, manage stable endpoints, and audit scheduled prompts.",
};

export default function DaemonTutorial() {
  return (
    <div className="page">
      <div className="page-body">
        <div className="wrap">
          <div className="tut">
            <header className="page-head reveal" style={{ maxWidth: "none" }}>
              <span className="eyebrow">Tutorial · 2 of 2</span>
              <h1>Daemon mode</h1>
              <p className="lede">Opt into a user-level supervisor when a Pi endpoint should survive terminal closure, logout, crashes, and reboot. The endpoint stays stable; each spawned process is a new runtime.</p>
            </header>

            <article className="prose">
              <DocsSection id="model" title="The lifecycle model">
                <p>One supervisor runs per computer and manages explicitly registered daemon endpoints. Registry v2 persists an opaque endpoint identifier, canonical cwd, name, creation time, and desired lifecycle.</p>
                <CodeBlock code="device → daemon endpoint → runtime → session / history generation" label="Daemon identity" language="text" />
                <p>Desired lifecycle is independent from process state: a daemon is persistently <InlineCode>running</InlineCode> or <InlineCode>stopped</InlineCode>. On supervisor startup, only desired-running registrations are restored.</p>
                <Callout variant="warning" title="Review Pi permissions first">
                  Daemons use the Pi configuration available to their user service. Review Pi tool permissions, providers, and model settings before enabling unattended work. The supervisor does not pass an extra extension argument; Pi settings are the only extension source.
                </Callout>
              </DocsSection>

              <DocsSection id="install" title="1. Install the supervisor once">
                <CodeBlock code={`npm install -g @yefengr/remote-pi\nremote-pi install`} label="Shell" language="bash" />
                <p>This installs a user-level <InlineCode>launchd</InlineCode> service on macOS or <InlineCode>systemd --user</InlineCode> service on Linux, links the CLI, and starts the supervisor. It is an explicit opt-in, separate from normal endpoint pairing.</p>
              </DocsSection>

              <DocsSection id="create" title="2. Register an endpoint">
                <CodeBlock code={`remote-pi create ~/Projects/backend\nremote-pi daemons\nremote-pi daemon status`} label="Shell" language="bash" />
                <p>Registration starts desired state as running, so a live supervisor starts it immediately. The browser PWA sees it as a daemon endpoint card when its runtime connects. Restarting keeps that endpoint card and creates a new runtime.</p>
                <p>A working directory can have multiple endpoints. Pair the computer separately in the PWA; pairing records belong to that computer, not to a shared fleet.</p>
              </DocsSection>

              <DocsSection id="fleet" title="3. Control and inspect lifecycle">
                <CodeBlock code={`remote-pi daemon start <daemon-id>\nremote-pi daemon stop <daemon-id>\nremote-pi daemon restart <daemon-id>\nremote-pi daemon status\nremote-pi remove <daemon-id>\nremote-pi remove-cwd ~/Projects/backend`} label="Lifecycle commands" language="bash" />
                <p><InlineCode>remove-cwd</InlineCode> is idempotent, which makes it safe for external worktree cleanup. Use <InlineCode>remove</InlineCode> when you already have the opaque daemon identifier.</p>
                <DocsSubsection title="Read status by dimension">
                  <p>Status reports registration, desired lifecycle, OS process, runtime readiness, Relay connection, and derived health separately. A ready runtime reconnecting to the Relay is degraded; the supervisor does not restart Pi for that condition. Deterministic startup or configuration errors become blocked and require an explicit correction and start or restart.</p>
                </DocsSubsection>
                <DocsSubsection title="Stale working directories">
                  <p>If a cwd disappears, prompt delivery is denied immediately. The supervisor confirms and reconciles the stale registration rather than spawning into a missing path.</p>
                </DocsSubsection>
              </DocsSection>

              <DocsSection id="cron" title="4. Schedule recurring prompts">
                <p>Cron schedules delivery only; it never changes a daemon&apos;s lifecycle. A job is accepted only when its registration exists, desired lifecycle is running, and runtime is ready.</p>
                <CodeBlock code={`remote-pi cron add <daemon-id> "0 9 * * 1-5" "Summarize the new PRs" --tz America/Sao_Paulo\nremote-pi cron list\nremote-pi cron log --tail 20`} label="Schedule and audit" language="bash" />
                <ul className="ml-6 list-disc space-y-2">
                  <li>Schedules must be at least 60 seconds apart.</li>
                  <li><InlineCode>--tz Area/City</InlineCode> selects a DST-aware timezone.</li>
                  <li><InlineCode>--no-skip-busy</InlineCode> allows a prompt during an active turn; otherwise it is audited as skipped.</li>
                  <li><InlineCode>--catchup</InlineCode> permits one missed run after supervisor startup.</li>
                </ul>
                <p>Every accepted or skipped outcome is appended to <InlineCode>~/.pi/remote/cron.jsonl</InlineCode>. A stopped, starting, failed, blocked, missing, or busy daemon is skipped and audited rather than started by the scheduler.</p>
              </DocsSection>

              <DocsSection id="logs" title="Logs and recovery">
                <CodeBlock code={`# Linux\njournalctl --user -u remote-pi-supervisord -f\n\n# macOS\ntail -f ~/.pi/remote/supervisord.log`} label="Logs" language="bash" />
                <p>For detailed service diagnostics, blocked errors, and registry recovery, read the <Link href="/docs#daemon-mode" className="text-accent underline">daemon reference</Link>.</p>
              </DocsSection>
            </article>

            <Pager prev={{ href: "/tutorials/getting-started", label: "Getting started" }} />
          </div>
        </div>
      </div>
      <RevealController />
    </div>
  );
}
