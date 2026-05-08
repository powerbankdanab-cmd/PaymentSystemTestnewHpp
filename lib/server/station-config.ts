export type StationProvider = "heycharge" | "appsphere";

export type StationConfig = {
  code: string;
  imei: string;
  name: string;
  provider: StationProvider;
  cabinetSn?: string;
};

const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "59": "Danab-Feynuus\nBowling",
  "60": "Danab-Java\nTaleex",
  "61": "Danab-Delik\nSomalia",
  "62": "Danab-Arena Cafe\nMogadishu",
};

function getStationProvider(code: string): StationProvider {
  const raw = String(process.env[`STATION_${code}_PROVIDER`] || "heycharge")
    .trim()
    .toLowerCase();

  return raw === "appsphere" ? "appsphere" : "heycharge";
}

function getStationHardwareId(code: string, provider: StationProvider) {
  if (provider === "appsphere") {
    return (
      process.env[`STATION_${code}_CABINET_SN`] ||
      process.env[`STATION_${code}_DEVICE_UUID`] ||
      process.env[`STATION_${code}_IMEI`] ||
      ""
    );
  }

  return process.env[`STATION_${code}_IMEI`] || "";
}

function buildStationConfig(code: string, name?: string): StationConfig {
  const provider = getStationProvider(code);
  const cabinetSn =
    process.env[`STATION_${code}_CABINET_SN`] ||
    process.env[`STATION_${code}_DEVICE_UUID`] ||
    undefined;

  return {
    code,
    imei: getStationHardwareId(code, provider),
    name: name || STATION_NAMES[code] || `Station ${code}`,
    provider,
    cabinetSn,
  };
}

export const STATION_CONFIGS: Record<string, StationConfig> = {
  "station58.danab.com": buildStationConfig("58"),
  "station58.danab.site": buildStationConfig("58"),
  "station59.danab.com": buildStationConfig("59"),
  "station59.danab.site": buildStationConfig("59"),
  "station60.danab.com": buildStationConfig("60"),
  "station60.danab.site": buildStationConfig("60"),
  "station61.danab.com": buildStationConfig("61"),
  "station61.danab.site": buildStationConfig("61"),
  "station62.danab.com": buildStationConfig("62"),
  "station62.danab.site": buildStationConfig("62"),
};

function normalizeStationCode(code: string): string {
  return String(code || "").replace(/\D/g, "");
}

export function getStationConfigByDomain(
  hostname: string,
): StationConfig | null {
  const config = STATION_CONFIGS[hostname.toLowerCase()];
  if (config) {
    return config;
  }

  const subdomain = hostname.split(".")[0];
  const stationNumber = subdomain.replace(/\D/g, "");
  if (stationNumber) {
    const dynamicConfig = getStationConfigByCode(stationNumber);
    if (dynamicConfig) {
      return dynamicConfig;
    }
  }

  if (process.env.STATION_CODE) {
    const provider = getStationProvider(process.env.STATION_CODE);
    const hardwareId =
      provider === "appsphere"
        ? process.env.STATION_CABINET_SN ||
          process.env.STATION_DEVICE_UUID ||
          process.env.STATION_IMEI
        : process.env.STATION_IMEI;

    if (!hardwareId) {
      return null;
    }

    return {
      code: process.env.STATION_CODE,
      imei: hardwareId,
      name: process.env.STATION_NAME || `Station ${process.env.STATION_CODE}`,
      provider,
      cabinetSn:
        process.env.STATION_CABINET_SN ||
        process.env.STATION_DEVICE_UUID ||
        undefined,
    };
  }

  return null;
}

export function getStationConfigByCode(code: string): StationConfig | null {
  const normalizedCode = normalizeStationCode(code);
  if (!normalizedCode) {
    return null;
  }

  const provider = getStationProvider(normalizedCode);
  const hardwareId = getStationHardwareId(normalizedCode, provider);
  if (hardwareId) {
    return buildStationConfig(normalizedCode);
  }

  return null;
}

function getConfiguredStationCodes() {
  const codes = new Set(Object.keys(STATION_NAMES));

  for (const key of Object.keys(process.env)) {
    const match = key.match(
      /^STATION_(\d+)_(IMEI|CABINET_SN|DEVICE_UUID|PROVIDER)$/,
    );
    if (match?.[1] && process.env[key]) {
      codes.add(match[1]);
    }
  }

  return Array.from(codes).sort((a, b) => Number(a) - Number(b));
}

export function getPublicStationConfigs(): StationConfig[] {
  const seen = new Set<string>();
  const stations: StationConfig[] = [];

  for (const code of getConfiguredStationCodes()) {
    const config = getStationConfigByCode(code);
    if (config && !seen.has(config.code)) {
      seen.add(config.code);
      stations.push(config);
    }
  }

  stations.sort((a, b) => Number(a.code) - Number(b.code));
  return stations;
}
