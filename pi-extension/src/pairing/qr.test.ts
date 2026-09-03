import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  QRSession,
  buildQRUri,
  clampPairTtlMs,
  TOKEN_TTL_MS,
  PAIR_TTL_MIN_MS,
  PAIR_TTL_MAX_MS,
} from "./qr.js";

describe("clampPairTtlMs", () => {
  test("passes a value inside the range unchanged", () => {
    expect(clampPairTtlMs(120_000)).toBe(120_000);
  });
  test("clamps below the minimum", () => {
    expect(clampPairTtlMs(1_000)).toBe(PAIR_TTL_MIN_MS);
  });
  test("clamps above the maximum", () => {
    expect(clampPairTtlMs(9_999_999)).toBe(PAIR_TTL_MAX_MS);
  });
  test("non-finite (NaN / Infinity) falls back to the default", () => {
    expect(clampPairTtlMs(Number.NaN)).toBe(TOKEN_TTL_MS);
    expect(clampPairTtlMs(Number.POSITIVE_INFINITY)).toBe(TOKEN_TTL_MS);
  });
});

describe("buildQRUri", () => {
  test("includes the canonical Relay URL for the PWA pairing target", () => {
    const uri = buildQRUri(
      "token",
      new Uint8Array(32).fill(1),
      "Local Pi",
      "11f4842b-726f-4c2d-8c86-c66ddf1f1d7a",
      "42f4842b-726f-4c2d-8c86-c66ddf1f1d7a",
      "https://relay.example.test",
    );

    expect(new URL(uri).searchParams.get("r")).toBe("https://relay.example.test");
  });

  test("omits an absent or non-HTTP Relay hint", () => {
    const args = [
      "token",
      new Uint8Array(32).fill(1),
      "Local Pi",
      "11f4842b-726f-4c2d-8c86-c66ddf1f1d7a",
      "42f4842b-726f-4c2d-8c86-c66ddf1f1d7a",
    ] as const;

    expect(new URL(buildQRUri(...args)).searchParams.has("r")).toBe(false);
    expect(new URL(buildQRUri(...args, "ftp://relay.example.test")).searchParams.has("r")).toBe(false);
    expect(new URL(buildQRUri(...args, "not a URL")).searchParams.has("r")).toBe(false);
  });
});

describe("QRSession.issueToken — ttl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("default ttl when none given", () => {
    vi.setSystemTime(new Date(1_000_000));
    const { expiresAt } = new QRSession().issueToken();
    expect(expiresAt).toBe(1_000_000 + TOKEN_TTL_MS);
  });

  test("honors a caller-supplied ttl", () => {
    vi.setSystemTime(new Date(1_000_000));
    const { expiresAt } = new QRSession().issueToken(120_000);
    expect(expiresAt).toBe(1_000_000 + 120_000);
  });

  test("token expires after its ttl", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const { token } = s.issueToken(10_000);
    vi.setSystemTime(new Date(10_001));
    expect(s.consumeToken(token)).toBe("expired");
  });

  test("token is single-use within its ttl", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const { token } = s.issueToken(60_000);
    expect(s.consumeToken(token)).toBe("ok");
    expect(s.consumeToken(token)).toBe("consumed");
  });

  test("issuing a new token invalidates the previous one", () => {
    vi.setSystemTime(new Date(0));
    const s = new QRSession();
    const first = s.issueToken(60_000).token;
    s.issueToken(60_000);
    expect(s.consumeToken(first)).toBe("unknown");
  });
});
