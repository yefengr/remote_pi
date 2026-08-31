import { useEffect, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { getPwaDatabase, makePwaDeviceId, openPwaDatabase, type PwaDeviceRecord } from "@/lib/pwa/db";
import {
  ACTIVE_DEVICE_SETTING,
  activeEndpointSettingKey,
  useActiveEndpointSelection,
  type ActiveEndpointSelection,
} from "./use-active-endpoint-selection";

const firstDevice: PwaDeviceRecord = {
  id: makePwaDeviceId("first-device"),
  deviceId: "first-device",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-09-01T00:00:00.000Z",
  hostname: "first-host",
};
const secondDevice: PwaDeviceRecord = {
  id: makePwaDeviceId("second-device"),
  deviceId: "second-device",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-09-02T00:00:00.000Z",
  hostname: "second-host",
};

type SelectionHarness = {
  selection: ActiveEndpointSelection;
  setDevices: (devices: PwaDeviceRecord[]) => void;
};

type SelectionHarnessProps = {
  onController: (controller: SelectionHarness) => void;
  onDeviceSelected: () => void;
};

function SelectionHarnessView({ onController, onDeviceSelected }: SelectionHarnessProps) {
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([firstDevice, secondDevice]);
  const selection = useActiveEndpointSelection({ devices, onDeviceSelected });

  useEffect(() => { onController({ selection, setDevices }); }, [onController, selection]);
  return <output data-testid="selection">{`${selection.activeDeviceId ?? "none"}:${selection.activeEndpointId ?? "none"}`}</output>;
}

async function renderSelection() {
  let current: SelectionHarness | null = null;
  const onDeviceSelected = vi.fn();
  const screen = await renderPwa(
    <SelectionHarnessView onController={(controller) => { current = controller; }} onDeviceSelected={onDeviceSelected} />,
  );
  await vi.waitFor(() => expect(current).not.toBeNull());
  return {
    screen,
    onDeviceSelected,
    controller: () => {
      if (!current) throw new Error("Selection hook did not mount.");
      return current;
    },
  };
}

beforeEach(async () => {
  const database = await openPwaDatabase();
  await database.transaction("rw", [database.identities, database.devices, database.endpoints, database.timelineEvents, database.settings], async () => {
    await Promise.all([
      database.identities.clear(),
      database.devices.clear(),
      database.endpoints.clear(),
      database.timelineEvents.clear(),
      database.settings.clear(),
    ]);
  });
});

test("restores the validated startup device, derives it, and saves active_device", async () => {
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.restoreActiveDevice(firstDevice.id);
    await vi.waitFor(() => expect(controller().selection.activeDevice).toEqual(firstDevice));
    await vi.waitFor(async () => expect((await getPwaDatabase().settings.get(ACTIVE_DEVICE_SETTING))?.value).toBe(firstDevice.id));
    expect(controller().selection.activeDeviceId).toBe(firstDevice.id);
  } finally {
    await screen.unmount();
  }
});

test("restores the selected endpoint for the active device", async () => {
  await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(firstDevice.id), value: "first-endpoint" });
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.restoreActiveDevice(firstDevice.id);
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("first-endpoint"));
  } finally {
    await screen.unmount();
  }
});

test("manual device selection resets consumers and restores the target endpoint", async () => {
  await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(secondDevice.id), value: "second-endpoint" });
  const { controller, onDeviceSelected, screen } = await renderSelection();
  try {
    controller().selection.selectDevice(secondDevice.id);
    expect(onDeviceSelected).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(secondDevice.id));
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("second-endpoint"));
  } finally {
    await screen.unmount();
  }
});

test("persists endpoint selections only for the active device", async () => {
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.restoreActiveDevice(firstDevice.id);
    await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(firstDevice.id));
    controller().selection.selectEndpoint("selected-endpoint");
    await vi.waitFor(async () => expect((await getPwaDatabase().settings.get(activeEndpointSettingKey(firstDevice.id)))?.value).toBe("selected-endpoint"));
    expect(controller().selection.activeEndpointId).toBe("selected-endpoint");
  } finally {
    await screen.unmount();
  }
});

test("paired activation sets both selections without resetting consumers", async () => {
  await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(secondDevice.id), value: "paired-endpoint" });
  const { controller, onDeviceSelected, screen } = await renderSelection();
  try {
    controller().selection.activatePairedDevice(secondDevice.id, "paired-endpoint");
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("paired-endpoint"));
    expect(controller().selection.activeDeviceId).toBe(secondDevice.id);
    expect(onDeviceSelected).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

test("suppresses a stale endpoint restoration after quickly switching devices", async () => {
  const database = getPwaDatabase();
  await Promise.all([
    database.settings.put({ key: activeEndpointSettingKey(firstDevice.id), value: "stale-endpoint" }),
    database.settings.put({ key: activeEndpointSettingKey(secondDevice.id), value: "current-endpoint" }),
  ]);
  const originalGet = database.settings.get.bind(database.settings) as (key: string) => Promise<unknown>;
  let resolveFirstRead: () => void = () => { throw new Error("First selection read did not start."); };
  const firstRead = new Promise<void>((resolve) => { resolveFirstRead = resolve; });
  const getSpy = vi.spyOn(database.settings, "get");
  (getSpy as unknown as { mockImplementation: (implementation: (key: string) => Promise<unknown>) => void }).mockImplementation(async (key) => {
    if (key === activeEndpointSettingKey(firstDevice.id)) await firstRead;
    return originalGet(key);
  });
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.selectDevice(firstDevice.id);
    await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(firstDevice.id));
    controller().selection.selectDevice(secondDevice.id);
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("current-endpoint"));
    resolveFirstRead();
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("current-endpoint"));
  } finally {
    getSpy.mockRestore();
    await screen.unmount();
  }
});

test("keeps a newly selected endpoint after its restoration read is already in flight", async () => {
  const database = getPwaDatabase();
  const endpointKey = activeEndpointSettingKey(firstDevice.id);
  await database.settings.put({ key: endpointKey, value: "restored-endpoint" });
  const originalGet = database.settings.get.bind(database.settings) as (key: string) => Promise<{ value?: string } | undefined>;
  let resolveReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { resolveReadStarted = resolve; });
  let resolveRestoreRead!: () => void;
  const restoreRead = new Promise<void>((resolve) => { resolveRestoreRead = resolve; });
  const getSpy = vi.spyOn(database.settings, "get");
  (getSpy as unknown as { mockImplementation: (implementation: (key: string) => Promise<unknown>) => void }).mockImplementation(async (key) => {
    if (key === endpointKey) {
      const restored = await originalGet(key);
      resolveReadStarted();
      await restoreRead;
      return restored;
    }
    return originalGet(key);
  });
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.restoreActiveDevice(firstDevice.id);
    await readStarted;
    controller().selection.selectEndpoint("new-endpoint");
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("new-endpoint"));
    await vi.waitFor(async () => expect((await originalGet(endpointKey))?.value).toBe("new-endpoint"));
    resolveRestoreRead();
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("new-endpoint"));
    await vi.waitFor(async () => expect((await originalGet(endpointKey))?.value).toBe("new-endpoint"));
  } finally {
    resolveRestoreRead();
    getSpy.mockRestore();
    await screen.unmount();
  }
});

test("clears the endpoint without a device and reports current active-device membership", async () => {
  const { controller, screen } = await renderSelection();
  try {
    controller().selection.activatePairedDevice(firstDevice.id, "first-endpoint");
    await vi.waitFor(() => expect(controller().selection.isActiveDevice(firstDevice.id)).toBe(true));
    controller().selection.selectDevice(null);
    await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBeNull());
    expect(controller().selection.isActiveDevice(firstDevice.id)).toBe(false);
    expect(controller().selection.isActiveDevice(secondDevice.id)).toBe(false);
  } finally {
    await screen.unmount();
  }
});
