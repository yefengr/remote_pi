"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPwaDatabase, type PwaDeviceRecord } from "@/lib/pwa/db";

export const ACTIVE_DEVICE_SETTING = "active_device";
export const ACTIVE_ENDPOINT_SETTING_PREFIX = "active_endpoint:";

export function activeEndpointSettingKey(deviceId: string): string {
  return `${ACTIVE_ENDPOINT_SETTING_PREFIX}${deviceId}`;
}

export type ActiveEndpointSelection = {
  activeDeviceId: string | null;
  activeEndpointId: string | null;
  activeDevice: PwaDeviceRecord | null;
  selectDevice: (deviceId: string | null) => void;
  selectEndpoint: (endpointId: string) => void;
  restoreActiveDevice: (deviceId: string | null) => void;
  activatePairedDevice: (deviceId: string, endpointId: string) => void;
  isActiveDevice: (deviceId: string) => boolean;
};

type UseActiveEndpointSelectionOptions = {
  devices: readonly PwaDeviceRecord[];
  onDeviceSelected: () => void;
};

/** Owns persisted device/endpoint selection, not endpoint presence or session state. */
export function useActiveEndpointSelection({ devices, onDeviceSelected }: UseActiveEndpointSelectionOptions): ActiveEndpointSelection {
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null);
  const activeDeviceIdRef = useRef<string | null>(null);
  const selectionEpochRef = useRef(0);
  const endpointRestoreGenerationRef = useRef(0);
  const activeDevicePersistChainRef = useRef(Promise.resolve());

  const activeDevice = useMemo(
    () => devices.find((device) => device.id === activeDeviceId) ?? null,
    [activeDeviceId, devices],
  );

  const setCurrentDevice = useCallback((deviceId: string | null) => {
    const selectionEpoch = ++selectionEpochRef.current;
    activeDeviceIdRef.current = deviceId;
    setActiveDeviceId(deviceId);
    if (deviceId === null) return;

    const persist = activeDevicePersistChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (selectionEpoch !== selectionEpochRef.current) return;
        await getPwaDatabase().settings.put({ key: ACTIVE_DEVICE_SETTING, value: deviceId });
      });
    activeDevicePersistChainRef.current = persist;
  }, []);

  useEffect(() => {
    const selectionEpoch = selectionEpochRef.current;
    if (!activeDevice) {
      queueMicrotask(() => {
        if (selectionEpoch === selectionEpochRef.current) setActiveEndpointId(null);
      });
      return;
    }

    const endpointRestoreGeneration = ++endpointRestoreGenerationRef.current;
    void getPwaDatabase().settings.get(activeEndpointSettingKey(activeDevice.id)).then((setting) => {
      if (
        endpointRestoreGeneration === endpointRestoreGenerationRef.current
        && selectionEpoch === selectionEpochRef.current
        && activeDeviceIdRef.current === activeDevice.id
      ) {
        setActiveEndpointId(setting?.value ?? null);
      }
    });
  }, [activeDevice]);

  const selectDevice = useCallback((deviceId: string | null) => {
    onDeviceSelected();
    setCurrentDevice(deviceId);
    setActiveEndpointId(null);
  }, [onDeviceSelected, setCurrentDevice]);

  const selectEndpoint = useCallback((endpointId: string) => {
    const device = activeDevice;
    if (!device || activeDeviceIdRef.current !== device.id) return;
    ++endpointRestoreGenerationRef.current;
    setActiveEndpointId(endpointId);
    void getPwaDatabase().settings.put({ key: activeEndpointSettingKey(device.id), value: endpointId });
  }, [activeDevice]);

  const restoreActiveDevice = useCallback((deviceId: string | null) => {
    setCurrentDevice(deviceId);
  }, [setCurrentDevice]);

  const activatePairedDevice = useCallback((deviceId: string, endpointId: string) => {
    ++endpointRestoreGenerationRef.current;
    setCurrentDevice(deviceId);
    setActiveEndpointId(endpointId);
  }, [setCurrentDevice]);

  const isActiveDevice = useCallback((deviceId: string) => activeDeviceIdRef.current === deviceId, []);

  return {
    activeDeviceId,
    activeEndpointId,
    activeDevice,
    selectDevice,
    selectEndpoint,
    restoreActiveDevice,
    activatePairedDevice,
    isActiveDevice,
  };
}
