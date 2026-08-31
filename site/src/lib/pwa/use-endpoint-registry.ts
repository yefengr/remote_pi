"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { acceptEndpointRuntime, mergeEndpoints } from "@/lib/pwa/runtime";
import {
  getPwaDatabase,
  listPwaEndpoints,
  makePwaDeviceId,
  makePwaEndpointId,
  type PwaDeviceRecord,
  type PwaEndpointRecord,
} from "@/lib/pwa/db";
import type { ControlFrame } from "@/lib/remote-pi/types";

export type UseEndpointRegistryOptions = {
  devices: readonly PwaDeviceRecord[];
  activeDevice: PwaDeviceRecord | null;
  onError: (message: string) => void;
};

export type EndpointRegistry = {
  endpoints: PwaEndpointRecord[];
  applyControl: (frame: ControlFrame) => void;
  markAllOffline: () => void;
  invalidatePersistence: () => Promise<void>;
};

function toEndpointRecord(deviceId: string, endpoint: Extract<ControlFrame, { type: "endpoints" }>["endpoints"][number], online: boolean): PwaEndpointRecord {
  const metadata = endpoint.metadata;
  return { id: makePwaEndpointId(deviceId, endpoint.endpoint_id), deviceId, endpointId: endpoint.endpoint_id, runtimeInstanceId: endpoint.runtime_instance_id, kind: metadata.kind, name: metadata.name ?? undefined, cwd: metadata.cwd ?? undefined, pid: metadata.pid ?? undefined, startedAt: metadata.started_at ?? undefined, model: metadata.model ?? undefined, thinking: metadata.thinking ?? undefined, working: metadata.working ?? undefined, online, updatedAt: Date.now() };
}

function endpointRecordFromEvent(frame: Extract<ControlFrame, { type: "endpoint_announced" | "endpoint_updated" }>): PwaEndpointRecord {
  return toEndpointRecord(frame.device_id, { endpoint_id: frame.endpoint_id, runtime_instance_id: frame.runtime_instance_id, metadata: frame.metadata }, true);
}

export function useEndpointRegistry({ devices, activeDevice, onError }: UseEndpointRegistryOptions): EndpointRegistry {
  const [endpoints, setEndpoints] = useState<PwaEndpointRecord[]>([]);
  const devicesRef = useRef(devices);
  const endpointsRef = useRef(endpoints);
  const onErrorRef = useRef(onError);
  const endpointRuntimeHistoryRef = useRef(new Map<string, Set<string>>());
  const endpointPersistEpochRef = useRef(0);
  const endpointPersistChainRef = useRef(Promise.resolve());

  const updateEndpoints = useCallback((update: PwaEndpointRecord[] | ((current: PwaEndpointRecord[]) => PwaEndpointRecord[])) => {
    const next = typeof update === "function" ? update(endpointsRef.current) : update;
    endpointsRef.current = next;
    setEndpoints(next);
  }, []);

  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    let cancelled = false;
    if (!activeDevice) {
      queueMicrotask(() => {
        if (!cancelled) updateEndpoints([]);
      });
      return () => { cancelled = true; };
    }
    void listPwaEndpoints(activeDevice.deviceId)
      .then((stored) => {
        if (!cancelled) updateEndpoints((current) => mergeEndpoints(
          stored.map((endpoint) => ({ ...endpoint, online: false })),
          current.filter((endpoint) => endpoint.deviceId === activeDevice.deviceId),
        ));
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current("Could not read local endpoints.");
      });
    return () => { cancelled = true; };
  }, [activeDevice, updateEndpoints]);

  const persistEndpoints = useCallback((deviceId: string, next: PwaEndpointRecord[]) => {
    const epoch = endpointPersistEpochRef.current;
    const operation = endpointPersistChainRef.current.then(async () => {
      if (epoch !== endpointPersistEpochRef.current) return;
      const database = getPwaDatabase();
      const device = await database.devices.get(makePwaDeviceId(deviceId));
      if (!device || epoch !== endpointPersistEpochRef.current) return;
      const persisted = next.map((endpoint) => { const record = { ...endpoint }; delete record.online; return record; });
      await database.endpoints.bulkPut(persisted);
      if (epoch !== endpointPersistEpochRef.current) return;
      updateEndpoints((current) => mergeEndpoints(current.filter((endpoint) => endpoint.deviceId !== deviceId), next));
    });
    endpointPersistChainRef.current = operation.catch(() => undefined);
    return operation;
  }, [updateEndpoints]);

  const invalidatePersistence = useCallback(async () => {
    endpointPersistEpochRef.current += 1;
    await endpointPersistChainRef.current;
  }, []);

  const applyControl = useCallback((frame: ControlFrame) => {
    const device = devicesRef.current.find((candidate) => candidate.deviceId === frame.device_id);
    if (!device) return;
    if (frame.type === "endpoints") {
      const snapshot = frame.endpoints.map((endpoint) => toEndpointRecord(frame.device_id, endpoint, true));
      const snapshotIds = new Set(snapshot.map((endpoint) => endpoint.id));
      const current = endpointsRef.current.filter((endpoint) => endpoint.deviceId === frame.device_id);
      const accepted = snapshot.filter((endpoint) => acceptEndpointRuntime(
        endpointRuntimeHistoryRef.current,
        current.find((candidate) => candidate.id === endpoint.id),
        endpoint,
      ));
      const acceptedIds = new Set(accepted.map((endpoint) => endpoint.id));
      const retained = current.filter((endpoint) => snapshotIds.has(endpoint.id) && !acceptedIds.has(endpoint.id));
      const stale = current.filter((endpoint) => !snapshotIds.has(endpoint.id)).map((endpoint) => ({ ...endpoint, online: false, updatedAt: Date.now() }));
      void persistEndpoints(frame.device_id, [...retained, ...accepted, ...stale]);
      return;
    }
    if (frame.type === "endpoint_announced" || frame.type === "endpoint_updated") {
      const next = endpointRecordFromEvent(frame);
      const current = endpointsRef.current.find((endpoint) => endpoint.id === next.id);
      if (!acceptEndpointRuntime(endpointRuntimeHistoryRef.current, current, next)) return;
      void persistEndpoints(frame.device_id, [...endpointsRef.current.filter((endpoint) => endpoint.id !== next.id), next]);
      return;
    }
    updateEndpoints((current) => current.map((endpoint) => endpoint.deviceId === frame.device_id && endpoint.endpointId === frame.endpoint_id && endpoint.runtimeInstanceId === frame.runtime_instance_id ? { ...endpoint, online: false, updatedAt: Date.now() } : endpoint));
  }, [persistEndpoints, updateEndpoints]);

  const markAllOffline = useCallback(() => {
    updateEndpoints((current) => current.map((endpoint) => endpoint.online ? { ...endpoint, online: false } : endpoint));
  }, [updateEndpoints]);

  return { endpoints, applyControl, markAllOffline, invalidatePersistence };
}
