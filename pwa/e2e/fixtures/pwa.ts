import { expect, test as base, type Page } from "playwright/test";

const DATABASE_NAME = "remote-pi-pwa";
const DATABASE_VERSION = 70;
const FIXTURE_RELAY_URL = "http://127.0.0.1:9";
const FIXTURE_DEVICE_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FIXTURE_ENDPOINT_ID = "e2e-endpoint";
const FIXTURE_RUNTIME_INSTANCE_ID = "e2e-runtime-1";
const FIXTURE_DEVICE_NAME = "E2E Pi";
const FIXTURE_ENDPOINT_NAME = "E2E endpoint";

type FixtureDevice = {
  id: string;
  deviceId: string;
  relayUrl: string;
  pairedAt: string;
  hostname: string;
  nickname: string;
};

type FixtureEndpoint = {
  id: string;
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  kind: "daemon";
  name: string;
  cwd: string;
  updatedAt: number;
};

type FixtureSetting = {
  key: string;
  value: string;
};

export type SeededWorkspace = {
  deviceId: string;
  deviceRecordId: string;
  endpointId: string;
  runtimeInstanceId: string;
  relayUrl: string;
};

type PwaFixture = {
  open: () => Promise<void>;
  seedWorkspace: () => Promise<SeededWorkspace>;
};

function fixtureWorkspace(): {
  device: FixtureDevice;
  endpoint: FixtureEndpoint;
  settings: FixtureSetting[];
  seeded: SeededWorkspace;
} {
  const deviceRecordId = encodeURIComponent(FIXTURE_DEVICE_ID);
  const endpointRecordId = `${deviceRecordId}:${encodeURIComponent(FIXTURE_ENDPOINT_ID)}`;
  const device: FixtureDevice = {
    id: deviceRecordId,
    deviceId: FIXTURE_DEVICE_ID,
    relayUrl: FIXTURE_RELAY_URL,
    pairedAt: "2026-01-01T00:00:00.000Z",
    hostname: FIXTURE_DEVICE_NAME,
    nickname: FIXTURE_DEVICE_NAME,
  };
  const endpoint: FixtureEndpoint = {
    id: endpointRecordId,
    deviceId: FIXTURE_DEVICE_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    runtimeInstanceId: FIXTURE_RUNTIME_INSTANCE_ID,
    kind: "daemon",
    name: FIXTURE_ENDPOINT_NAME,
    cwd: "/workspace/e2e",
    updatedAt: 1,
  };

  return {
    device,
    endpoint,
    settings: [
      { key: "relay_url", value: FIXTURE_RELAY_URL },
      { key: "active_device", value: deviceRecordId },
      { key: `active_endpoint:${deviceRecordId}`, value: FIXTURE_ENDPOINT_ID },
    ],
    seeded: {
      deviceId: FIXTURE_DEVICE_ID,
      deviceRecordId,
      endpointId: FIXTURE_ENDPOINT_ID,
      runtimeInstanceId: FIXTURE_RUNTIME_INSTANCE_ID,
      relayUrl: FIXTURE_RELAY_URL,
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
  await expect(page.getByRole("heading", { name: "Your endpoints, within reach." })).toBeVisible();
}

export const test = base.extend<{ pwa: PwaFixture }>({
  pwa: async ({ baseURL, page }, provide) => {
    await provide({
      open: () => openPwa(page),
      seedWorkspace: async () => {
        await openPwa(page);
        assertLocalTestOrigin(baseURL, page.url());
        const workspace = fixtureWorkspace();

        await page.evaluate(async ({ databaseName, databaseVersion, device, endpoint, settings }) => {
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
            throw new Error(`Expected PWA Dexie v7 IndexedDB schema, received version ${database.version}.`);
          }
          const endpointIndexes = Array.from(database.transaction("endpoints", "readonly").objectStore("endpoints").indexNames);
          const requiredEndpointIndexes = ["deviceId", "[deviceId+endpointId]", "endpointId", "updatedAt"];
          if (requiredEndpointIndexes.some((index) => !endpointIndexes.includes(index))) {
            database.close();
            throw new Error(`Expected PWA endpoint indexes, received ${endpointIndexes.join(", ")}.`);
          }

          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(["devices", "endpoints", "settings"], "readwrite");
            transaction.objectStore("devices").put(device);
            transaction.objectStore("endpoints").put(endpoint);
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
          device: workspace.device,
          endpoint: workspace.endpoint,
          settings: workspace.settings,
        });

        await page.reload();
        await expect(page.getByText(FIXTURE_ENDPOINT_NAME, { exact: true })).toHaveCount(1);
        await expect(page.getByPlaceholder("Reconnect to send a message")).toBeDisabled();
        return workspace.seeded;
      },
    });
  },
});

export { expect };
