import { headers } from "next/headers";

import { getRequiredEnv } from "@/lib/server/env";
import {
  getStationConfigByDomain,
} from "@/lib/server/station-config";
import type {
  StationConfig,
  StationProvider,
} from "@/lib/server/station-config";

function getFallbackProvider(): StationProvider {
  return String(process.env.STATION_PROVIDER || "heycharge")
    .trim()
    .toLowerCase() === "appsphere"
    ? "appsphere"
    : "heycharge";
}

function getFallbackHardwareId(provider: StationProvider) {
  if (provider === "appsphere") {
    return (
      process.env.STATION_CABINET_SN ||
      process.env.STATION_DEVICE_UUID ||
      process.env.STATION_IMEI ||
      ""
    );
  }

  return process.env.STATION_IMEI || "";
}

export async function getActiveStationConfig(): Promise<StationConfig> {
  const headersList = await headers();
  const host = headersList.get("host") || "";

  const config = getStationConfigByDomain(host);
  if (config?.code && config.imei) {
    return config;
  }

  const provider = getFallbackProvider();
  const code = getRequiredEnv("STATION_CODE");
  const imei = getFallbackHardwareId(provider);
  if (!imei) {
    throw new Error(`Station ${code} hardware ID is not configured`);
  }

  return {
    code,
    imei,
    name: process.env.STATION_NAME || `Station ${code}`,
    provider,
    cabinetSn:
      process.env.STATION_CABINET_SN ||
      process.env.STATION_DEVICE_UUID ||
      undefined,
  };
}

export async function getActiveStationCode() {
  return (await getActiveStationConfig()).code;
}

export async function getStationImei() {
  return (await getActiveStationConfig()).imei;
}
