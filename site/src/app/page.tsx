import { Hero } from "@/components/landing/hero";
import { Install } from "@/components/landing/install";
import { Pillars, Strip, GithubCTA } from "@/components/landing/sections";
import { RevealController } from "@/components/landing/reveal-controller";

export default function Home() {
  return (
    <>
      <Hero />
      <Pillars />
      <Install />
      <Strip />
      <GithubCTA />
      <RevealController />
    </>
  );
}
