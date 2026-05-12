import { getDb } from "@/lib/server/firebase-admin";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { getReservedBatteryIds } from "@/lib/server/payment/battery-lock";
import {
  queryStationBatteries as queryHeyChargeStationBatteries,
  getAvailableBattery as getHeyChargeAvailableBattery,
  isSpecificBatteryReadyForRental as isHeyChargeSpecificBatteryReadyForRental,
  markProblemSlot as markHeyChargeProblemSlot,
  MIN_AVAILABLE_BATTERY_PERCENT,
  releaseBattery as releaseHeyChargeBattery,
} from "@/lib/server/payment/heycharge";
import { parseResponseBody, toErrorMessage } from "@/lib/server/payment/http";
import { getActiveRentedBatteryIds } from "@/lib/server/payment/rentals";
import type { Battery } from "@/lib/server/payment/types";
import type { StationProvider } from "@/lib/server/station-config";

export { MIN_AVAILABLE_BATTERY_PERCENT };

type ReleaseBatteryInput = {
  imei: string;
  batteryId: string;
  slotId: string;
};

export type PowerbankProvider = {
  name: StationProvider;
  displayName: string;
  verifyEjection: boolean;
  queryStationBatteries(imei: string): Promise<Battery[]>;
  getAvailableBattery(imei: string): Promise<Battery | null>;
  isSpecificBatteryReadyForRental(input: ReleaseBatteryInput): Promise<boolean>;
  releaseBattery(input: ReleaseBatteryInput): Promise<unknown>;
  markProblemSlot(
    imei: string,
    slotId: string,
    batteryId: string,
    reason: string,
  ): Promise<void>;
};

const heyChargeProvider: PowerbankProvider = {
  name: "heycharge",
  displayName: "HeyCharge",
  verifyEjection: true,
  queryStationBatteries: queryHeyChargeStationBatteries,
  getAvailableBattery: getHeyChargeAvailableBattery,
  isSpecificBatteryReadyForRental: isHeyChargeSpecificBatteryReadyForRental,
  releaseBattery: releaseHeyChargeBattery,
  markProblemSlot: markHeyChargeProblemSlot,
};

function getBridgeBaseUrl() {
  const raw = process.env.APPSPHERE_BRIDGE_URL;
  if (!raw) {
    throw new Error(
      "AppSphere bridge is not configured. Set APPSPHERE_BRIDGE_URL before enabling an AppSphere station.",
    );
  }

  return raw.replace(/\/+$/, "");
}

function buildBridgeUrl(cabinetSn: string, suffix: string) {
  const encodedSn = encodeURIComponent(cabinetSn.trim().toUpperCase());
  return `${getBridgeBaseUrl()}/api/cabinets/${encodedSn}${suffix}`;
}

function bridgeHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.APPSPHERE_BRIDGE_SECRET) {
    headers["x-bridge-secret"] = process.env.APPSPHERE_BRIDGE_SECRET;
  }

  return headers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text && text !== "-" && text !== "0x00000000") {
      return value;
    }
  }

  return null;
}

function toText(value: unknown) {
  const chosen = firstValue(value);
  return chosen === null ? "" : String(chosen).trim();
}

function toNumber(value: unknown) {
  const text = toText(value);
  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  const text = toText(value).toLowerCase();
  return ["true", "1", "yes", "online", "occupied", "present"].includes(text);
}

function statusLooksHealthy(slot: Record<string, unknown>) {
  const statusCode = toText(
    firstValue(slot.status, slot.statusCode, slot.statusHex, slot.slotStatus),
  ).toLowerCase();
  const statusText = toText(
    firstValue(slot.statusText, slot.battery_status, slot.slot_status),
  ).toLowerCase();

  if (!statusCode && !statusText) {
    return true;
  }

  if (["1", "0x01", "normal", "ok", "available"].includes(statusCode)) {
    return true;
  }

  return (
    statusText.includes("normal") ||
    statusText.includes("ok") ||
    statusText.includes("available") ||
    statusText.includes("充电宝正常")
  );
}

function extractSlotList(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const data = asRecord(root.data);
  const machineSummary = asRecord(root.machineSummary);
  const parsed = asRecord(root.parsed);
  const msgBody = asRecord(parsed?.msgBody);

  const candidates = [
    root.batteries,
    root.slots,
    data?.batteries,
    data?.slots,
    machineSummary?.slots,
    msgBody?.slots,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      });
    }
  }

  return [];
}

function mapAppSphereSlotToBattery(slot: Record<string, unknown>): Battery | null {
  const batteryId = toText(
    firstValue(
      slot.battery_id,
      slot.batteryId,
      slot.powerBankSn,
      slot.singleSN,
      slot.sn,
      slot.terminalId,
      slot.powerDeviceId,
    ),
  );
  const slotId = toText(
    firstValue(slot.slot_id, slot.slotId, slot.slot, slot.slotIndex, slot.hole),
  );
  const occupied =
    toBoolean(slot.occupied) ||
    Boolean(batteryId && batteryId !== "0" && batteryId !== "00000000");

  if (!batteryId || !slotId || !occupied) {
    return null;
  }

  const level = toNumber(
    firstValue(
      slot.battery_capacity,
      slot.batteryLevel,
      slot.level,
      slot.remainingPower,
      slot.electricityQuantity,
    ),
  );
  const healthy = statusLooksHealthy(slot);
  const capacity = level === null ? "0" : String(Math.min(Math.max(level, 0), 100));

  return {
    battery_id: batteryId,
    slot_id: slotId,
    lock_status: healthy ? "1" : "0",
    battery_capacity: capacity,
    battery_abnormal: healthy ? "0" : "1",
    cable_abnormal: "0",
    battery_status: toText(firstValue(slot.statusText, slot.battery_status)),
    slot_status: toText(firstValue(slot.slotStatus, slot.slot_status)),
  };
}

async function fetchAppSphereBridge(
  cabinetSn: string,
  suffix: string,
  init?: RequestInit,
) {
  const response = await fetch(buildBridgeUrl(cabinetSn, suffix), {
    ...init,
    cache: "no-store",
    headers: bridgeHeaders(),
  });
  const payload = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(toErrorMessage(payload, "AppSphere bridge request failed"));
  }

  return payload;
}

async function queryAppSphereStationBatteries(cabinetSn: string) {
  const payload = await fetchAppSphereBridge(cabinetSn, "/batteries");
  return extractSlotList(payload).flatMap((slot) => {
    const battery = mapAppSphereSlotToBattery(slot);
    return battery ? [battery] : [];
  });
}

function isHealthyMappedBattery(battery: Battery) {
  const capacity = Number.parseInt(battery.battery_capacity, 10);
  return (
    Boolean(normalizeBatteryId(battery.battery_id)) &&
    Boolean(battery.slot_id) &&
    battery.lock_status === "1" &&
    Number.isFinite(capacity) &&
    capacity >= MIN_AVAILABLE_BATTERY_PERCENT &&
    battery.battery_abnormal === "0" &&
    battery.cable_abnormal === "0"
  );
}

async function getProblemSlotIds(
  imei: string,
  liveBatteries: Battery[] = [],
): Promise<Set<string>> {
  const snap = await getDb()
    .collection("problem_slots")
    .where("imei", "==", imei)
    .where("resolved", "==", false)
    .get();

  const healthySlotIds = new Set(
    liveBatteries.filter(isHealthyMappedBattery).map((battery) => battery.slot_id),
  );
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const slotId = doc.data().slot_id;
    if (slotId) {
      const normalizedSlotId = String(slotId);
      if (healthySlotIds.has(normalizedSlotId)) {
        await doc.ref.update({
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy: "payment-auto-healthy",
        });
        continue;
      }
      ids.add(normalizedSlotId);
    }
  }
  return ids;
}

function isBatteryRentable(battery: Battery, problemSlots: Set<string>) {
  const capacity = Number.parseInt(battery.battery_capacity, 10);
  return (
    Boolean(normalizeBatteryId(battery.battery_id)) &&
    Boolean(battery.slot_id) &&
    battery.lock_status === "1" &&
    capacity >= MIN_AVAILABLE_BATTERY_PERCENT &&
    battery.battery_abnormal === "0" &&
    battery.cable_abnormal === "0" &&
    !problemSlots.has(battery.slot_id)
  );
}

async function getAppSphereAvailableBattery(cabinetSn: string) {
  const batteries = await queryAppSphereStationBatteries(cabinetSn);
  const batteryIds = batteries.map((battery) => battery.battery_id);

  const [problemSlots, reservedIds, rentedIds] = await Promise.all([
    getProblemSlotIds(cabinetSn, batteries),
    getReservedBatteryIds(cabinetSn),
    getActiveRentedBatteryIds(batteryIds),
  ]);

  const available = batteries
    .filter(
      (battery) =>
        isBatteryRentable(battery, problemSlots) &&
        !reservedIds.has(normalizeBatteryId(battery.battery_id)) &&
        !rentedIds.has(normalizeBatteryId(battery.battery_id)),
    )
    .sort(
      (a, b) =>
        Number.parseInt(b.battery_capacity, 10) -
        Number.parseInt(a.battery_capacity, 10),
    );

  return available[0] || null;
}

async function isAppSphereSpecificBatteryReadyForRental({
  imei,
  batteryId,
  slotId,
}: ReleaseBatteryInput) {
  const normalizedBatteryId = normalizeBatteryId(batteryId);
  if (!normalizedBatteryId) {
    return false;
  }

  const batteries = await queryAppSphereStationBatteries(imei);
  const [problemSlots, rentedIds] = await Promise.all([
    getProblemSlotIds(imei, batteries),
    getActiveRentedBatteryIds([normalizedBatteryId]),
  ]);

  const battery = batteries.find(
    (entry) =>
      normalizeBatteryId(entry.battery_id) === normalizedBatteryId &&
      entry.slot_id === slotId,
  );

  if (!battery) {
    return false;
  }

  return (
    isBatteryRentable(battery, problemSlots) &&
    !rentedIds.has(normalizedBatteryId)
  );
}

async function releaseAppSphereBattery({
  imei,
  batteryId,
  slotId,
}: ReleaseBatteryInput) {
  return fetchAppSphereBridge(imei, "/eject", {
    method: "POST",
    body: JSON.stringify({
      batteryId,
      slotId,
      terminalId: batteryId,
    }),
  });
}

async function markAppSphereProblemSlot(
  imei: string,
  slotId: string,
  batteryId: string,
  reason: string,
) {
  await getDb().collection("problem_slots").add({
    imei,
    provider: "appsphere",
    slot_id: slotId,
    battery_id: normalizeBatteryId(batteryId) || batteryId,
    reason,
    resolved: false,
    createdAt: new Date(),
  });
}

const appSphereProvider: PowerbankProvider = {
  name: "appsphere",
  displayName: "AppSphere",
  verifyEjection: false,
  queryStationBatteries: queryAppSphereStationBatteries,
  getAvailableBattery: getAppSphereAvailableBattery,
  isSpecificBatteryReadyForRental: isAppSphereSpecificBatteryReadyForRental,
  releaseBattery: releaseAppSphereBattery,
  markProblemSlot: markAppSphereProblemSlot,
};

export function getPowerbankProvider(
  provider: StationProvider = "heycharge",
): PowerbankProvider {
  return provider === "appsphere" ? appSphereProvider : heyChargeProvider;
}
