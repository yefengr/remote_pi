import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  QRSession,
  buildQRUri,
  type TokenReservation,
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

describe("QRSession pairing reservations", () => {
  test("reserves and commits a token, then replays the same completion", () => {
    const session = new QRSession();
    const { token } = session.issueToken();
    const first = session.reserveToken(token, "owner-a", "request-1");
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("expected reservation");
    const completion = { type: "pair_ok", requestId: "request-1" };
    expect(session.commitToken(first.reservation, completion)).toBe(true);
    expect(session.reserveToken(token, "owner-a", "request-1")).toEqual({ status: "committed", completion });
    expect(session.isReservationCurrent(first.reservation)).toBe(false);
  });

  test("replays a committed result for the same request after token expiry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const session = new QRSession();
      const { token } = session.issueToken(10_000);
      const first = session.reserveToken(token, "owner-a", "request-1");
      if (first.status !== "reserved") throw new Error("expected reservation");
      const completion = { type: "pair_ok", requestId: "request-1" };
      expect(session.commitToken(first.reservation, completion)).toBe(true);
      vi.setSystemTime(new Date(10_001));

      expect(session.reserveToken(token, "owner-a", "request-1")).toEqual({ status: "committed", completion });
      expect(session.reserveToken(token, "owner-b", "request-1").status).toBe("consumed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("only the same Owner and request can reuse a reservation", () => {
    const session = new QRSession();
    const { token } = session.issueToken();
    expect(session.reserveToken(token, "owner-a", "request-1").status).toBe("reserved");
    expect(session.reserveToken(token, "owner-b", "request-1").status).toBe("consumed");
    expect(session.reserveToken(token, "owner-a", "request-2").status).toBe("consumed");
  });

  test("release keeps the token private to the original request", () => {
    const session = new QRSession();
    const { token } = session.issueToken();
    const result = session.reserveToken(token, "owner-a", "request-1");
    if (result.status !== "reserved") throw new Error("expected reservation");
    expect(session.releaseToken(result.reservation)).toBe(true);
    expect(session.reserveToken(token, "owner-b", "request-1").status).toBe("consumed");
    const retry = session.reserveToken(token, "owner-a", "request-1");
    expect(retry.status).toBe("reserved");
    if (retry.status === "reserved") expect(retry.reservation).not.toBe(result.reservation);
  });

  test("rejects stale reservations and invalid commits", () => {
    const session = new QRSession();
    const { token } = session.issueToken();
    const result = session.reserveToken(token, "owner-a", "request-1");
    if (result.status !== "reserved") throw new Error("expected reservation");
    const forged = { token, ownerId: "owner-a", requestId: "request-1" } as TokenReservation;
    expect(session.isReservationCurrent(forged)).toBe(false);
    expect(session.commitToken(forged, "completion")).toBe(false);
    expect(session.commitToken(result.reservation, "completion")).toBe(true);
    expect(session.commitToken(result.reservation, "other")).toBe(false);
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
