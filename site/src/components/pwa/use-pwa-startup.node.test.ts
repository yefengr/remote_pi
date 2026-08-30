import { describe, expect, test } from "vitest";
import { normalizeStartupPeers, selectStartupPeerId } from "./use-pwa-startup";
import type { PwaPeerRecord } from "@/lib/pwa/db";

function peer(overrides: Partial<PwaPeerRecord> = {}): PwaPeerRecord {
  return {
    id: "AQI%3D:office",
    remoteEpk: "AQI=",
    sessionName: "Office Pi",
    relayUrl: "https://relay.example.test",
    pairedAt: "2026-01-01T00:00:00.000Z",
    roomId: "office",
    ...overrides,
  };
}

describe("PWA startup peer helpers", () => {
  test("normalizes missing pairing id and room while migrating the legacy Relay URL", () => {
    const result = normalizeStartupPeers([peer({ id: "", remoteEpk: "AQI", roomId: "", relayUrl: "https://relay-rp1.jacobmoura.work" })]);

    expect(result).toEqual({
      changed: true,
      peers: [peer({ id: "AQI%3D:main", remoteEpk: "AQI=", roomId: "main", relayUrl: "https://relay-pi.yefengr.cn" })],
    });
  });

  test("keeps an existing custom Relay URL without a migration write", () => {
    const storedPeer = peer();

    expect(normalizeStartupPeers([storedPeer])).toEqual({ peers: [storedPeer], changed: false });
  });

  test("prefers a stored pairing id over all fallback choices", () => {
    const first = peer({ id: "first" });
    const stored = peer({ id: "stored", remoteEpk: "AwQ=" });

    expect(selectStartupPeerId([first, stored], "stored")).toBe("stored");
  });

  test("falls back to the stored remote public key when its pairing id changed", () => {
    const first = peer({ id: "first", remoteEpk: "AwQ=" });
    const stored = peer({ id: "replacement", remoteEpk: "AQI=" });

    expect(selectStartupPeerId([first, stored], "AQI")).toBe("replacement");
  });

  test("falls back to the first pairing or null when no pairing exists", () => {
    expect(selectStartupPeerId([peer({ id: "first" }), peer({ id: "second", remoteEpk: "AwQ=" })], undefined)).toBe("first");
    expect(selectStartupPeerId([], undefined)).toBeNull();
  });

  test("preserves the existing invalid stored remote id failure", () => {
    expect(() => selectStartupPeerId([peer()], "@")).toThrow("Invalid base64");
  });
});
