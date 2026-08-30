import type { Metadata } from "next";
import { LegalShell, LegalSection } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for Remote Pi — what data is processed by the Relay and stored in your local browser workspace.",
};

const CONTACT_EMAIL = "jacob@flutterando.com.br";

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      lastUpdated="2026-08-28"
      subtitle={<p>Data controller: <strong className="text-fg">Flutterando Desenvolvimento de Programas de Computador LTDA</strong> (CNPJ 33.637.582/0001-70). Data Protection Officer (DPO): <strong className="text-fg">Jacob Moura</strong> — <a className="text-accent underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>}
    >
      <LegalSection id="who" number={1} title="Who We Are (Data Controller)">
        <p>Remote Pi is operated by Flutterando Desenvolvimento de Programas de Computador LTDA, a company incorporated in Brazil (CNPJ 33.637.582/0001-70), with offices at Rua Clara Nunes, 198, Maringá/PR, CEP 87.045-650.</p>
        <p>For any matter related to this Policy or to the processing of your personal data, contact our Data Protection Officer at <a className="text-accent underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
      </LegalSection>

      <LegalSection id="collect" number={2} title="Data We Collect">
        <h3 className="text-base font-semibold text-fg">2.1 Data you provide directly</h3>
        <p>Remote Pi has no account, email registration, profile, or payment information. Pairing generates cryptographic keys locally on your devices.</p>
        <p>The browser PWA stores its owner key, paired device records, endpoint records, and endpoint-scoped timeline locally in IndexedDB in the browser profile. Those records include public identifiers, a friendly name where supplied, Relay URL, endpoint/runtime metadata, and locally retained timeline content. Private keys remain in that browser profile and are not sent to the Relay.</p>

        <h3 className="text-base font-semibold text-fg">2.2 Data processed by the public Relay</h3>
        <p>When you connect to the public Relay operated by Flutterando, it processes the minimum data needed to operate authenticated WebSocket routing:</p>
        <ul className="ml-6 list-disc space-y-2">
          <li><strong className="text-fg">Connection metadata</strong> — source IP address, timestamps, public-key identifier, device/endpoint/runtime identifiers, and basic transport statistics such as bytes, timing, and sizes. This is logged for at most 30 days for abuse mitigation and reliable operation.</li>
          <li><strong className="text-fg">Opaque route containers</strong> — the Relay forwards a <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs text-fg">ct</code> payload container between paired browser devices and authorized endpoints. The shipped Relay does not decode, log, or persist that content.</li>
          <li><strong className="text-fg">In-memory endpoint registry</strong> — connected endpoint and authorization information is held only while needed to route current connections. It is not a database and is lost when the Relay restarts.</li>
        </ul>
        <p>Self-hosting moves this Relay processing to your own infrastructure.</p>

        <h3 className="text-base font-semibold text-fg">2.3 Data we do NOT collect</h3>
        <ul className="ml-6 list-disc space-y-2">
          <li>Precise device location or contacts.</li>
          <li>Background microphone or camera access. The browser requests camera access only when you scan a pairing QR or explicitly attach an image.</li>
          <li>Advertising identifiers, behavioral analytics, or tracking telemetry.</li>
          <li>Relay-side persistent records of endpoint inventory, pairing history, or message traffic.</li>
        </ul>
      </LegalSection>

      <LegalSection id="use" number={3} title="How We Use Your Data">
        <p>The limited Relay metadata is used to operate and route the service, detect and mitigate abuse, investigate incidents, and protect the security and reliability of the Relay. We do not use it for advertising, profiling, or behavioral analytics.</p>
      </LegalSection>

      <LegalSection id="legal-bases" number={4} title="Legal Bases (LGPD Article 7)">
        <ul className="ml-6 list-disc space-y-2">
          <li><strong className="text-fg">Performance of a contract</strong> (Article 7, V) — to provide the Relay service you connect to.</li>
          <li><strong className="text-fg">Legitimate interest</strong> (Article 7, IX) — to ensure the security and integrity of the Relay infrastructure.</li>
        </ul>
      </LegalSection>

      <LegalSection id="sharing" number={5} title="Data Sharing">
        <p>We do not sell or rent your data, and we do not share connection metadata with third parties for advertising or analytics. We may disclose data only when required by a valid legal order under Brazilian law and only to the extent strictly necessary.</p>
        <p>If you self-host or use a third-party Relay, that operator is the controller for data processed by that infrastructure. This Policy does not cover third-party Relays.</p>
      </LegalSection>

      <LegalSection id="international" number={6} title="International Transfer">
        <p>The public Relay may be hosted outside Brazil. Where this occurs, transfers use safeguards consistent with Article 33 of the LGPD. You can avoid this public Relay processing by self-hosting on infrastructure under your control.</p>
      </LegalSection>

      <LegalSection id="retention" number={7} title="Data Retention">
        <p>Relay connection logs are retained for a maximum of <strong className="text-fg">30 days</strong>, after which they are deleted or anonymized. Aggregated, non-identifying operational statistics may be retained longer for capacity planning.</p>
        <p>Your PWA owner key, paired device records, endpoints, and timeline persist in local IndexedDB until you revoke a pairing, clear Remote Pi site data, or clear browser storage. We do not have access to that browser storage.</p>
      </LegalSection>

      <LegalSection id="rights" number={8} title="Your Rights (LGPD Article 18)">
        <p>Subject to the LGPD, you may request confirmation, access, correction, anonymization, blocking, deletion where applicable, information about sharing, and revocation of consent where consent is the legal basis. Contact <a className="text-accent underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> to exercise these rights. We may need to verify your identity before fulfilling a request.</p>
      </LegalSection>

      <LegalSection id="security" number={9} title="Security and trust model">
        <ul className="ml-6 list-disc space-y-2">
          <li><strong className="text-fg">TLS</strong> protects connections between clients and the Relay when HTTPS/WSS is used.</li>
          <li><strong className="text-fg">Ed25519 authentication and per-device ACLs</strong> restrict session routing to paired, authorized devices.</li>
          <li><strong className="text-fg">Local private keys</strong> generated in the PWA remain in its IndexedDB workspace.</li>
          <li><strong className="text-fg">Opaque payload forwarding</strong> means the shipped Relay does not decode, log, or persist route-container content.</li>
        </ul>
        <p><strong className="text-fg">Important:</strong> opaque forwarding is an implementation boundary, not a guarantee against an operator who controls the Relay executable or TLS endpoint. If confidentiality from the Relay operator is required, run your own Relay on infrastructure you control.</p>
        <p>If you believe a device has been compromised, revoke the affected local pairing immediately and report the incident to <a className="text-accent underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
      </LegalSection>

      <LegalSection id="minors" number={10} title="Children and Minors"><p>The Service is not directed at individuals under the age of 13. We do not knowingly collect personal data from minors.</p></LegalSection>
      <LegalSection id="cookies" number={11} title="Cookies"><p>This site does not use tracking, advertising, or analytics cookies. The PWA and Pi-side extension do not use cookies.</p></LegalSection>
      <LegalSection id="updates" number={12} title="Policy Updates"><p>We may update this Policy from time to time. The current version is published on this site with the last-updated date shown above. Material changes will also be announced in the project README.</p></LegalSection>
      <LegalSection id="contact" number={13} title="Contact"><p>For privacy questions or LGPD requests, contact <a className="text-accent underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. You may also lodge a complaint with the Brazilian National Data Protection Authority (ANPD).</p></LegalSection>
    </LegalShell>
  );
}
