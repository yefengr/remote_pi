import Link from "next/link";
import { Fragment } from "react";
import {
  IconGateway,
  IconAlwaysOn,
  IconMesh,
  IconArrow,
  IconMic,
  IconImage,
  IconOpenSource,
  IconSelfHost,
  IconGithub,
  IconStar,
} from "@/components/landing/icons";
import type { ReactNode } from "react";

const GITHUB_URL = "https://github.com/jacobaraujo7/remote_pi";
const PROTOCOL_URL = `${GITHUB_URL}/blob/main/PROTOCOL.md`;

/* ---------------- Pillars ---------------- */
type Pillar = {
  icon: ReactNode;
  tag: string;
  title: string;
  proof: string;
  link: string;
  href: string;
};

const PILLARS: Pillar[] = [
  {
    icon: <IconGateway />,
    tag: "01 / gateway",
    title: "Drive any agent from a browser PWA.",
    proof:
      "Open the PWA, pair with a QR, then send prompts, voice, and images from anywhere.",
    link: "How pairing works",
    href: "#install",
  },
  {
    icon: <IconAlwaysOn />,
    tag: "02 / daemon",
    title: "Run as many agents as you want, 24/7.",
    proof:
      "Promote any folder to a background daemon; survives logout, answers at 3am.",
    link: "Daemon how-to",
    href: "/tutorials/daemon",
  },
  {
    icon: <IconMesh />,
    tag: "03 / endpoints",
    title: "Every paired machine, clearly separated.",
    proof:
      "Pair each computer independently, then choose its live Pi endpoints from the same browser PWA.",
    link: "See the protocol",
    href: PROTOCOL_URL,
  },
];

function PillarLink({ href, label }: { href: string; label: string }) {
  const inner = (
    <>
      {label} <IconArrow />
    </>
  );
  if (href.startsWith("http")) {
    return (
      <a className="plink" href={href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a className="plink" href={href}>
        {inner}
      </a>
    );
  }
  return (
    <Link className="plink" href={href}>
      {inner}
    </Link>
  );
}

export function Pillars() {
  return (
    <section className="section pillars" id="pillars">
      <div className="wrap">
        <div className="pillar-grid">
          {PILLARS.map((p, i) => (
            <article
              className="pillar reveal"
              key={p.tag}
              style={{ transitionDelay: `${i * 0.08}s` }}
            >
              <span className="tag">{p.tag}</span>
              <span className="picon">{p.icon}</span>
              <h3>{p.title}</h3>
              <p className="proof">{p.proof}</p>
              <PillarLink href={p.href} label={p.link} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Secondary strip ---------------- */
const STRIP: { icon: ReactNode; label: string }[] = [
  { icon: <IconMic />, label: "Voice — dictate, no cloud transcription" },
  { icon: <IconImage />, label: "Image — send a shot to a multimodal agent" },
  { icon: <IconOpenSource />, label: "Open source — MIT licensed" },
  { icon: <IconSelfHost />, label: "Self-host — run the relay behind a VPN" },
];

export function Strip() {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="strip-inner">
          {STRIP.map((s, i) => (
            <Fragment key={s.label}>
              <span className="strip-item">
                {s.icon} {s.label}
              </span>
              {i < STRIP.length - 1 && <span className="strip-sep">·</span>}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- GitHub CTA ---------------- */
export function GithubCTA() {
  return (
    <section className="cta">
      <div className="wrap cta-inner reveal">
        <span className="eyebrow">Open source</span>
        <h2>Open source, all the way down.</h2>
        <p>
          Active MVP. Read the source, run the protocol, or self-host the relay —
          it&apos;s all on GitHub.
        </p>
        <div>
          <a
            className="btn btn-primary"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconGithub /> View on GitHub
          </a>
        </div>
        <div className="cta-stars">
          <span>
            <IconStar /> MIT licensed
          </span>
          <span>
            <IconStar /> Self-hostable relay
          </span>
          <span>
            <IconStar /> Harness-agnostic protocol
          </span>
        </div>
      </div>
    </section>
  );
}
