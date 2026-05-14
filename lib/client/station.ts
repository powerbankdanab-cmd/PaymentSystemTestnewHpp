const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "02": "Danab-Feynuus\nBowling",
  "03": "Danab-Java\nTaleex",
  "04": "Danab-Delik\nSomalia",
  "05": "Danab-Arena Cafe\nMogadishu",
  "20": "Elite space\nDanab Powerbank",
  "21": "Karmel\nDanab Powerbank",
  "22": "Milgo caffe\nDanab Powerbank",
  "27": "Elite private\nDanab Powerbank",
  "34": "Crepe one\nDanab Powerbank",
};

export const DEFAULT_RENTAL_AMOUNT = 0.75;

const STATION_RENTAL_AMOUNTS: Record<string, number> = {
  "20": 1,
  "27": 1,
};

const LEGACY_STATION_CODES: Record<string, string> = {
  "59": "02",
  "60": "03",
  "61": "04",
  "62": "05",
  "63": "20",
};

function getStationCodeFromHostname(hostname: string) {
  const subdomain = hostname.split(".")[0];
  const rawStationNumber = subdomain.replace(/\D/g, "");
  return LEGACY_STATION_CODES[rawStationNumber] || rawStationNumber;
}

export function getStationName(): string {
  if (typeof window === "undefined") {
    return "Danab Power Bank";
  }

  const stationNumber = getStationCodeFromHostname(window.location.hostname);

  if (stationNumber && STATION_NAMES[stationNumber]) {
    return STATION_NAMES[stationNumber];
  }

  return "Danab Power Bank";
}

export function getStationRentalAmount(): number {
  if (typeof window === "undefined") {
    return DEFAULT_RENTAL_AMOUNT;
  }

  const stationNumber = getStationCodeFromHostname(window.location.hostname);
  return STATION_RENTAL_AMOUNTS[stationNumber] || DEFAULT_RENTAL_AMOUNT;
}
