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
  "02": "Danab-Feynuus\nBowling",
  "03": "Danab-Java\nTaleex",
  "04": "Danab-Delik\nSomalia",
  "05": "Danab-Arena Cafe\nMogadishu",
  "20": "Elite Hotel\nDanab Powerbank",
  "21": "Karmel\nDanab Powerbank",
  "22": "Milgo caffe\nDanab Powerbank",
  "27": "Danab Powerbank\nAppSphere 49000627",
  "34": "Danab Powerbank\nAppSphere 49000634",
};

const DEFAULT_APPSPHERE_CABINETS: Record<string, string> = {
  "20": "49000620",
  "21": "49000621",
  "22": "49000622",
  "27": "49000627",
  "34": "49000634",
};

const LEGACY_STATION_CODES: Record<string, string> = {
  "59": "02",
  "60": "03",
  "61": "04",
  "62": "05",
  "63": "20",
};

const LEGACY_ENV_CODES: Record<string, string[]> = {
  "02": ["59"],
  "03": ["60"],
  "04": ["61"],
  "05": ["62"],
  "20": ["63"],
};

function getStationEnv(code: string, key: string) {
  const codes = [code, ...(LEGACY_ENV_CODES[code] || [])];

  for (const candidate of codes) {
    const value = process.env[`STATION_${candidate}_${key}`];
    if (value) {
      return value;
    }
  }

  return "";
}

function getStationProvider(code: string): StationProvider {
  const configuredProvider = getStationEnv(code, "PROVIDER");
  if (!configuredProvider && DEFAULT_APPSPHERE_CABINETS[code]) {
    return "appsphere";
  }

  const raw = String(configuredProvider || "heycharge").trim().toLowerCase();

  return raw === "appsphere" ? "appsphere" : "heycharge";
}

function getStationHardwareId(code: string, provider: StationProvider) {
  if (provider === "appsphere") {
    return (
      getStationEnv(code, "CABINET_SN") ||
      getStationEnv(code, "DEVICE_UUID") ||
      getStationEnv(code, "IMEI") ||
      DEFAULT_APPSPHERE_CABINETS[code] ||
      ""
    );
  }

  return getStationEnv(code, "IMEI") || "";
}

function buildStationConfig(code: string, name?: string): StationConfig {
  const provider = getStationProvider(code);
  const cabinetSn =
    getStationEnv(code, "CABINET_SN") ||
    getStationEnv(code, "DEVICE_UUID") ||
    DEFAULT_APPSPHERE_CABINETS[code] ||
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
  "station02.danab.com": buildStationConfig("02"),
  "station02.danab.site": buildStationConfig("02"),
  "station03.danab.com": buildStationConfig("03"),
  "station03.danab.site": buildStationConfig("03"),
  "station04.danab.com": buildStationConfig("04"),
  "station04.danab.site": buildStationConfig("04"),
  "station05.danab.com": buildStationConfig("05"),
  "station05.danab.site": buildStationConfig("05"),
  "station20.danab.com": buildStationConfig("20"),
  "station20.danab.site": buildStationConfig("20"),
  "station21.danab.com": buildStationConfig("21"),
  "station21.danab.site": buildStationConfig("21"),
  "station22.danab.com": buildStationConfig("22"),
  "station22.danab.site": buildStationConfig("22"),
  "station27.danab.com": buildStationConfig("27"),
  "station27.danab.site": buildStationConfig("27"),
  "station34.danab.com": buildStationConfig("34"),
  "station34.danab.site": buildStationConfig("34"),
  "station59.danab.com": buildStationConfig("02"),
  "station59.danab.site": buildStationConfig("02"),
  "station60.danab.com": buildStationConfig("03"),
  "station60.danab.site": buildStationConfig("03"),
  "station61.danab.com": buildStationConfig("04"),
  "station61.danab.site": buildStationConfig("04"),
  "station62.danab.com": buildStationConfig("05"),
  "station62.danab.site": buildStationConfig("05"),
  "station63.danab.com": buildStationConfig("20"),
  "station63.danab.site": buildStationConfig("20"),
};

function normalizeStationCode(code: string): string {
  const normalized = String(code || "").replace(/\D/g, "");
  return LEGACY_STATION_CODES[normalized] || normalized;
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
    const fallbackCode = normalizeStationCode(process.env.STATION_CODE);
    const provider = getStationProvider(fallbackCode);
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
      code: fallbackCode,
      imei: hardwareId,
      name: process.env.STATION_NAME || `Station ${fallbackCode}`,
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
      codes.add(normalizeStationCode(match[1]));
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
