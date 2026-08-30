import type { Metadata } from "next";
import Link from "next/link";
import { DocsSection, DocsSubsection, InlineCode } from "@/components/docs-shell";
import { CodeBlock } from "@/components/code-block";
import { Callout } from "@/components/callout";
import { Pager } from "@/components/pager";
import { RevealController } from "@/components/landing/reveal-controller";

export const metadata: Metadata = {
  title: "Getting started",
  description: "Install Remote Pi, pair the browser PWA with a Pi endpoint, and send your first command.",
};

export default function GettingStartedTutorial() {
  return (
    <div className="page">
      <div className="page-body">
        <div className="wrap">
          <div className="tut">
            <header className="page-head reveal" style={{ maxWidth: "none" }}>
              <span className="eyebrow">Tutorial · 1 of 2</span>
              <h1>Getting started</h1>
              <p className="lede">Pair a browser PWA with a Pi endpoint on one computer, then drive that endpoint&apos;s current runtime from the browser. Plan on about five minutes.</p>
            </header>

            <article className="prose">
              <DocsSection id="prereqs" title="Before you start">
                <ul className="ml-6 list-disc space-y-2">
                  <li>A computer with <strong className="text-fg">Pi</strong> and <strong className="text-fg">Node 20+</strong>.</li>
                  <li>The <Link className="text-accent underline" href="/app">Remote Pi browser PWA</Link> in a modern browser.</li>
                </ul>
                <p>You can install the PWA as a standalone browser app. No native app or store download is required.</p>
              </DocsSection>

              <DocsSection id="install" title="1. Install and connect the endpoint">
                <p>Install the Pi plugin, then connect the current endpoint and show its pairing QR:</p>
                <CodeBlock code={`pi install npm:@yefengr/remote-pi\n# In Pi:\n/remote-pi\n/remote-pi pair`} label="Install and pair" language="text" />
                <DocsSubsection title="/remote-pi">
                  <p>The first run creates this folder&apos;s local endpoint configuration and connects it to the configured Relay. Later runs reconnect the endpoint. The endpoint is stable while this Pi process is running; every process start has its own runtime identity.</p>
                </DocsSubsection>
                <DocsSubsection title="/remote-pi pair">
                  <p>Prints a one-time QR and copy-paste URI that identifies the current endpoint and runtime. Run it on each computer you want to pair.</p>
                </DocsSubsection>
                <Callout variant="note" title="Pairing is per computer">
                  Pair and revoke devices on each computer separately. The browser PWA can keep several paired device records and several endpoint cards for each device.
                </Callout>
              </DocsSection>

              <DocsSection id="pair" title="2. Pair the browser PWA">
                <ol className="ml-6 list-decimal space-y-2">
                  <li>Open <Link href="/app" className="text-accent underline">/app</Link>.</li>
                  <li>Choose <strong className="text-fg">Pair a device</strong> and scan the QR.</li>
                  <li>Select the announced endpoint card for the Pi you just paired.</li>
                </ol>
                <p>Pairing uses local cryptographic keys and Relay transport authentication. The PWA stores its owner identity, device records, endpoint records, and endpoint-scoped timeline in its browser workspace.</p>
                <p>Use <InlineCode>/remote-pi devices</InlineCode> to inspect the pairings kept by this computer. Use <InlineCode>/remote-pi revoke &lt;shortid&gt;</InlineCode> to remove one.</p>
              </DocsSection>

              <DocsSection id="first-command" title="3. Send your first command">
                <p>Type a prompt into the selected endpoint&apos;s browser chat:</p>
                <CodeBlock code="List the files in this folder and tell me what this project is." label="From the app" language="text" />
                <p>The prompt reaches the selected Pi runtime as a normal user message and its response streams back to the endpoint timeline. The PWA can also compact context, start a new session, set a model, and set thinking level.</p>
              </DocsSection>

              <DocsSection id="next" title="Where to go next">
                <p>For an endpoint that should survive logout and reboots, enable the user-level supervisor:</p>
                <p><Link href="/tutorials/daemon" className="text-accent underline">Continue to Daemon mode</Link>.</p>
              </DocsSection>
            </article>

            <Pager next={{ href: "/tutorials/daemon", label: "Daemon mode" }} />
          </div>
        </div>
      </div>
      <RevealController />
    </div>
  );
}
