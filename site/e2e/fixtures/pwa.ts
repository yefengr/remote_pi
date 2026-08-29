import { expect, test as base, type Page } from "playwright/test";

const DATABASE_NAME = "remote-pi-pwa";
const DATABASE_VERSION = 60; // Dexie schema version 6 maps to IndexedDB version 60.
const FIXTURE_RELAY_URL = "http://127.0.0.1:9";
const FIXTURE_REMOTE_EPK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FIXTURE_ROOM_ID = "e2e-room";
const FIXTURE_NAME = "E2E Pi";

type FixturePairing = {
  id: string;
  remoteEpk: string;
  sessionName: string;
  nickname: string;
  relayUrl: string;
  pairedAt: string;
  roomId: string;
};

type FixtureRoom = {
  id: string;
  peerEpk: string;
  roomId: string;
  name: string;
  cwd: string;
  updatedAt: number;
};

type FixtureSetting = {
  key: string;
  value: string;
};

export type SeededWorkspace = {
  pairingId: string;
  relayUrl: string;
  remoteEpk: string;
  roomId: string;
};

type PwaFixture = {
  open: () => Promise<void>;
  seedWorkspace: () => Promise<SeededWorkspace>;
};

function fixtureWorkspace(): {
  pairing: FixturePairing;
  room: FixtureRoom;
  settings: FixtureSetting[];
  seeded: SeededWorkspace;
} {
  const pairingId = `${encodeURIComponent(FIXTURE_REMOTE_EPK)}:${encodeURIComponent(FIXTURE_ROOM_ID)}`;
  const pairing: FixturePairing = {
    id: pairingId,
    remoteEpk: FIXTURE_REMOTE_EPK,
    sessionName: FIXTURE_NAME,
    nickname: FIXTURE_NAME,
    relayUrl: FIXTURE_RELAY_URL,
    pairedAt: "2026-01-01T00:00:00.000Z",
    roomId: FIXTURE_ROOM_ID,
  };
  const room: FixtureRoom = {
    id: `${FIXTURE_REMOTE_EPK}:${FIXTURE_ROOM_ID}`,
    peerEpk: FIXTURE_REMOTE_EPK,
    roomId: FIXTURE_ROOM_ID,
    name: "E2E session",
    cwd: "/workspace/e2e",
    updatedAt: 1,
  };

  return {
    pairing,
    room,
    settings: [
      { key: "relay_url", value: FIXTURE_RELAY_URL },
      { key: "active_peer", value: pairingId },
      { key: `active_room:${pairingId}`, value: FIXTURE_ROOM_ID },
    ],
    seeded: {
      pairingId,
      relayUrl: FIXTURE_RELAY_URL,
      remoteEpk: FIXTURE_REMOTE_EPK,
      roomId: FIXTURE_ROOM_ID,
    },
  };
}

function assertLocalTestOrigin(baseURL: string | undefined, pageURL: string) {
  const hostname = new URL(baseURL ?? pageURL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`Refusing to write E2E IndexedDB outside localhost: ${hostname}`);
  }
}

async function openPwa(page: Page) {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Your agents, within reach." })).toBeVisible();
}

export const test = base.extend<{ pwa: PwaFixture }>({
  pwa: async ({ baseURL, page }, provide) => {
    await provide({
      open: () => openPwa(page),
      seedWorkspace: async () => {
        await openPwa(page);
        assertLocalTestOrigin(baseURL, page.url());
        const workspace = fixtureWorkspace();

        await page.evaluate(async ({ databaseName, databaseVersion, pairing, room, settings }) => {
          const hostname = window.location.hostname;
          if (hostname !== "127.0.0.1" && hostname !== "localhost") {
            throw new Error(`Refusing to write E2E IndexedDB outside localhost: ${hostname}`);
          }

          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName);
            request.onerror = () => reject(request.error ?? new Error("Could not open the PWA database."));
            request.onsuccess = () => resolve(request.result);
          });
          if (database.version !== databaseVersion) {
            database.close();
            throw new Error(`Expected PWA Dexie v6 IndexedDB schema, received version ${database.version}.`);
          }

          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(["pairings", "rooms", "settings"], "readwrite");
            transaction.objectStore("pairings").put(pairing);
            transaction.objectStore("rooms").put(room);
            for (const setting of settings) transaction.objectStore("settings").put(setting);
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
            transaction.onerror = () => reject(transaction.error ?? new Error("Could not seed the PWA workspace."));
            transaction.onabort = () => reject(transaction.error ?? new Error("PWA workspace seed was aborted."));
          });
        }, {
          databaseName: DATABASE_NAME,
          databaseVersion: DATABASE_VERSION,
          pairing: workspace.pairing,
          room: workspace.room,
          settings: workspace.settings,
        });

        await page.reload();
        await expect(page.getByPlaceholder("Reconnect to send a message")).toBeVisible();
        return workspace.seeded;
      },
    });
  },
});

export { expect };
