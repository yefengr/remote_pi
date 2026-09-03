import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

export type PairingStatus = "online" | "checking" | "offline" | "partial";
export type PairingPresence = {
  status: PairingStatus;
  onlineEndpoints: number;
  totalEndpoints: number;
  lastSeenAt?: number;
};

/** Derives device-level endpoint presence without owning endpoint or session state. */
export function derivePairingPresence(
  devices: readonly PwaDeviceRecord[],
  endpoints: readonly PwaEndpointRecord[],
): Record<string, PairingPresence> {
  return Object.fromEntries(devices.map((device) => {
    const deviceEndpoints = endpoints.filter((endpoint) => endpoint.deviceId === device.deviceId);
    const onlineEndpoints = deviceEndpoints.filter((endpoint) => endpoint.online).length;
    const status: PairingStatus = deviceEndpoints.length === 0
      ? "checking"
      : onlineEndpoints === 0
        ? "offline"
        : onlineEndpoints === deviceEndpoints.length
          ? "online"
          : "partial";
    return [device.id, {
      status,
      onlineEndpoints,
      totalEndpoints: deviceEndpoints.length,
      lastSeenAt: deviceEndpoints.find((endpoint) => endpoint.online)?.updatedAt,
    }];
  }));
}
