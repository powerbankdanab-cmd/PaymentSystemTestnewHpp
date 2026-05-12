const DEFAULT_ONLINE_MAX_AGE_MINUTES = 5;

export const STATION_ONLINE_MAX_AGE_MS = (() => {
  const rawMinutes = Number.parseInt(
    String(
      process.env.STATION_ONLINE_MAX_AGE_MINUTES ||
        process.env.APPSPHERE_ONLINE_MAX_AGE_MINUTES ||
        "",
    ),
    10,
  );
  const minutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0
      ? rawMinutes
      : DEFAULT_ONLINE_MAX_AGE_MINUTES;

  return Math.min(minutes, 180) * 60 * 1000;
})();

export function parseProviderTimestampMillis(value: unknown): number | null {
  if (!value) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }

    const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
      ? trimmed
      : `${trimmed}Z`;
    const time = Date.parse(normalized);
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "object") {
    const record = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      _seconds?: number;
      _nanoseconds?: number;
      seconds?: number;
      nanoseconds?: number;
    };

    if (typeof record.toMillis === "function") {
      const time = record.toMillis();
      return Number.isFinite(time) ? time : null;
    }

    if (typeof record.toDate === "function") {
      const time = record.toDate().getTime();
      return Number.isFinite(time) ? time : null;
    }

    const seconds =
      typeof record._seconds === "number" ? record._seconds : record.seconds;
    const nanoseconds =
      typeof record._nanoseconds === "number"
        ? record._nanoseconds
        : record.nanoseconds || 0;

    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
    }
  }

  return null;
}

export function isFreshProviderTimestamp(value: unknown): boolean {
  const time = parseProviderTimestampMillis(value);
  if (time === null) return false;
  const ageMs = Date.now() - time;
  return ageMs >= 0 && ageMs <= STATION_ONLINE_MAX_AGE_MS;
}
