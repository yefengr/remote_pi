import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  DecodeError,
  decodeClientFrameV2,
  decodeServerFrameV2,
  parseTimelineEventV2,
  parseTimelinePartialV2,
} from "./protocol-v2";

type FixtureDirection = "client" | "server" | "timeline" | "marker";
type FixtureCase = {
  id: string;
  direction: FixtureDirection;
  valid: boolean;
  value: Record<string, unknown>;
  expected_code?: DecodeError["code"];
};
type FixtureManifest = {
  schema_version: 2;
  cases: FixtureCase[];
};

const manifest = JSON.parse(
  readFileSync(new URL("../../../../docs/reference/protocol/fixtures/v2/manifest.json", import.meta.url), "utf8"),
) as FixtureManifest;

function parseFixture(fixture: FixtureCase): unknown {
  if (fixture.direction === "client") return decodeClientFrameV2(fixture.value);
  if (fixture.direction === "server") return decodeServerFrameV2(fixture.value);
  if (fixture.direction === "marker") return fixture.value;
  if (fixture.value.type === "timeline_partial") return parseTimelinePartialV2(fixture.value);
  return parseTimelineEventV2(fixture.value);
}

test("loads the shared Protocol v2 manifest", () => {
  expect(manifest.schema_version).toBe(2);
  expect(manifest.cases.length > 0).toBe(true);
  const ids = manifest.cases.map((fixture) => fixture.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(manifest.cases.some((fixture) => fixture.direction === "marker")).toBe(true);
});

test("accepts every valid non-marker fixture through its direction-specific parser", () => {
  for (const fixture of manifest.cases.filter((candidate) => candidate.valid && candidate.direction !== "marker")) {
    expect(() => parseFixture(fixture), fixture.id).not.toThrow();
  }
});

test("rejects every invalid non-marker fixture with its manifest error code", () => {
  for (const fixture of manifest.cases.filter((candidate) => !candidate.valid && candidate.direction !== "marker")) {
    expect(fixture.expected_code, `${fixture.id} must declare expected_code`).toBeTruthy();
    let thrown: unknown;
    try {
      parseFixture(fixture);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, fixture.id).toBeInstanceOf(DecodeError);
    expect((thrown as DecodeError).code, fixture.id).toBe(fixture.expected_code);
  }
});
