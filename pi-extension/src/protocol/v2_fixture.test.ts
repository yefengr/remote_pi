import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DecodeError,
  decodeClientFrameV2,
  decodeServerFrameV2,
  parseMarkerV2,
  parseTimelineEventV2,
  parseTimelinePartialV2,
} from "./v2/index.js";

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
  readFileSync(new URL("../../../.orchestration/contracts/fixtures/v2/manifest.json", import.meta.url), "utf8"),
) as FixtureManifest;

function parseFixture(fixture: FixtureCase): unknown {
  if (fixture.direction === "client") return decodeClientFrameV2(fixture.value);
  if (fixture.direction === "server") return decodeServerFrameV2(fixture.value);
  if (fixture.direction === "marker") return parseMarkerV2(fixture.value);
  if (fixture.value.type === "timeline_partial") return parseTimelinePartialV2(fixture.value);
  return parseTimelineEventV2(fixture.value);
}

describe("shared Protocol v2 fixture corpus", () => {
  test("loads a versioned manifest with unique case ids", () => {
    expect(manifest.schema_version).toBe(2);
    expect(manifest.cases.length).toBeGreaterThan(0);
    const ids = manifest.cases.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("accepts every valid fixture through its direction-specific parser", () => {
    for (const fixture of manifest.cases.filter((candidate) => candidate.valid)) {
      expect(() => parseFixture(fixture), fixture.id).not.toThrow();
    }
  });

  test("rejects every invalid fixture with its manifest error code", () => {
    for (const fixture of manifest.cases.filter((candidate) => !candidate.valid)) {
      expect(fixture.expected_code, `${fixture.id} must declare expected_code`).toBeDefined();
      expect(() => parseFixture(fixture), fixture.id).toThrowError(
        expect.objectContaining({ name: "DecodeError", code: fixture.expected_code }),
      );
    }
  });

  test("includes the marker fixture and validates it with the extension marker parser", () => {
    const marker = manifest.cases.find((fixture) => fixture.direction === "marker" && fixture.valid);
    expect(marker).toBeDefined();
    expect(parseMarkerV2(marker!.value)).toEqual(marker!.value);
    expect(manifest.cases.some((fixture) => fixture.id === "timeline-event-fragment")).toBe(true);
  });
});
