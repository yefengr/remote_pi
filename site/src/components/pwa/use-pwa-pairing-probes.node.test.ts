import { describe, expect, test } from "vitest";
import { selectPairingProbePeers } from "./use-pwa-pairing-probes";
import type { PwaPeerRecord } from "@/lib/pwa/db";

function peer(id: string, remoteEpk: string): PwaPeerRecord {
  return {
    id,
    remoteEpk,
    sessionName: id,
    relayUrl: "https://relay.example.test",
    pairedAt: "2026-01-01T00:00:00.000Z",
    roomId: "main",
  };
}

describe("selectPairingProbePeers", () => {
  test("excludes the active public key while retaining the first record for each remote key in order", () => {
    const active = peer("active", "active-key");
    const firstOffice = peer("office-main", "office-key");
    const duplicateOffice = peer("office-archive", "office-key");
    const studio = peer("studio", "studio-key");

    expect(selectPairingProbePeers([active, firstOffice, duplicateOffice, studio], active.remoteEpk)).toEqual([firstOffice, studio]);
  });

  test("returns all first representatives in input order when no active peer exists", () => {
    const first = peer("first", "first-key");
    const duplicate = peer("duplicate", "first-key");
    const second = peer("second", "second-key");

    expect(selectPairingProbePeers([first, duplicate, second], undefined)).toEqual([first, second]);
  });

  test("returns no probe peers for an empty pairing list", () => {
    expect(selectPairingProbePeers([], undefined)).toEqual([]);
  });
});
