import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
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
  readFileSync(new URL("../../../../.orchestration/contracts/fixtures/v2/manifest.json", import.meta.url), "utf8"),
) as FixtureManifest;

function parseFixture(fixture: FixtureCase): unknown {
  if (fixture.direction === "client") return decodeClientFrameV2(fixture.value);
  if (fixture.direction === "server") return decodeServerFrameV2(fixture.value);
  if (fixture.direction === "marker") return fixture.value;
  if (fixture.value.type === "timeline_partial") return parseTimelinePartialV2(fixture.value);
  return parseTimelineEventV2(fixture.value);
}

test("loads the shared Protocol v2 manifest", () => {
  assert.equal(manifest.schema_version, 2);
  assert.ok(manifest.cases.length > 0);
  const ids = manifest.cases.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(manifest.cases.some((fixture) => fixture.direction === "marker"));
});

test("accepts every valid non-marker fixture through its direction-specific parser", () => {
  for (const fixture of manifest.cases.filter((candidate) => candidate.valid && candidate.direction !== "marker")) {
    assert.doesNotThrow(() => parseFixture(fixture), fixture.id);
  }
});

test("rejects every invalid non-marker fixture with its manifest error code", () => {
  for (const fixture of manifest.cases.filter((candidate) => !candidate.valid && candidate.direction !== "marker")) {
    assert.ok(fixture.expected_code, `${fixture.id} must declare expected_code`);
    assert.throws(
      () => parseFixture(fixture),
      (error: unknown) => error instanceof DecodeError && error.code === fixture.expected_code,
      fixture.id,
    );
  }
});
