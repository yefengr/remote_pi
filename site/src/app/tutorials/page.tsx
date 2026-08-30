import type { Metadata } from "next";
import Link from "next/link";
import { IconArrow } from "@/components/landing/icons";
import { RevealController } from "@/components/landing/reveal-controller";

export const metadata: Metadata = {
  title: "Tutorials",
  description: "Hands-on guides for pairing the Remote Pi browser PWA and running managed Pi endpoints.",
};

type Step = { n: string; tag: string; title: string; href: string; desc: string };

const STEPS: Step[] = [
  {
    n: "1",
    tag: "01 / 02",
    title: "Getting started",
    href: "/tutorials/getting-started",
    desc: "Install Remote Pi, pair the browser PWA with an endpoint, and send your first prompt.",
  },
  {
    n: "2",
    tag: "02 / 02",
    title: "Daemon mode",
    href: "/tutorials/daemon",
    desc: "Opt into the supervisor, manage desired lifecycle, and audit scheduled prompts.",
  },
];

function StepCard({ step }: { step: Step }) {
  return (
    <Link className="step-card reveal" href={step.href}>
      <div className="sc-top"><span className="sc-num">{step.n}</span><span className="sc-tag">{step.tag}</span></div>
      <h3>{step.title}</h3>
      <p>{step.desc}</p>
      <span className="sc-link">Open tutorial <IconArrow /></span>
    </Link>
  );
}

export default function TutorialsIndexPage() {
  return (
    <div className="page">
      <div className="page-body">
        <div className="wrap">
          <header className="page-head reveal">
            <span className="eyebrow">Tutorials</span>
            <h1>Learn Remote Pi by doing.</h1>
            <p className="lede">
              Start by pairing a browser with a Pi endpoint. Add the explicit supervisor opt-in only when an endpoint should outlive its terminal. For command details and configuration, read the <Link href="/docs">reference docs</Link>.
            </p>
          </header>
          <div className="card-list">
            {STEPS.map((step) => <StepCard key={step.href} step={step} />)}
          </div>
        </div>
      </div>
      <RevealController />
    </div>
  );
}
