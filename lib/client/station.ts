const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "02": "Danab-Feynuus\nBowling",
  "03": "Danab-Java\nTaleex",
  "04": "Danab-Delik\nSomalia",
  "05": "Danab-Arena Cafe\nMogadishu",
  "20": "Danab Powerbank\nAppSphere",
};

const LEGACY_STATION_CODES: Record<string, string> = {
  "59": "02",
  "60": "03",
  "61": "04",
  "62": "05",
  "63": "20",
};

export function getStationName(): string {
  if (typeof window === "undefined") {
    return "Danab Power Bank";
  }

  const hostname = window.location.hostname;

  // Extract station number from subdomain (e.g., station58.danab.site -> 58)
  const subdomain = hostname.split(".")[0];
  const rawStationNumber = subdomain.replace(/\D/g, "");
  const stationNumber = LEGACY_STATION_CODES[rawStationNumber] || rawStationNumber;

  if (stationNumber && STATION_NAMES[stationNumber]) {
    return STATION_NAMES[stationNumber];
  }

  return "Danab Power Bank";
}
