// Daily-uptime rollup maths, shared by every caller that has confirmed-down
// intervals for a monitor (SQLite import today, a live prober later).
// Pure functions of input rows: no knowledge of where the rows came from.

export type UptimeCheckRow = { timestamp: number; status: number };
export type Interval = { start: number; end: number };

export const DOWN = 0;
export const SUSTAINED_DOWN_SECONDS = 600;

export function confirmedDownIntervals(
  rows: UptimeCheckRow[],
  windowStart: number,
  cutoff: number,
): Interval[] {
  const intervals: Interval[] = [];
  let downSince: number | null = null;

  for (const row of rows) {
    if (row.timestamp < windowStart) {
      downSince = row.status === DOWN ? windowStart : null;
      continue;
    }
    if (row.status === DOWN && downSince === null) downSince = row.timestamp;
    if (row.status !== DOWN && downSince !== null) {
      intervals.push({ start: downSince, end: Math.min(row.timestamp, cutoff) });
      downSince = null;
    }
  }
  if (downSince !== null && downSince < cutoff) intervals.push({ start: downSince, end: cutoff });
  return intervals;
}

function overlapSeconds(intervals: Interval[], start: number, end: number) {
  return intervals.reduce((total, interval) => {
    const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
    return total + Math.max(0, overlap);
  }, 0);
}

function longestOverlapSeconds(intervals: Interval[], start: number, end: number) {
  return intervals.reduce((longest, interval) => {
    const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
    return Math.max(longest, overlap);
  }, 0);
}

export type RollUpDayInput = {
  /** UTC day-start, unix seconds. */
  start: number;
  intervals: Interval[];
  /** Count of maintenance windows touching the day; defaults to 0. */
  maintenance?: number;
  /** Count of "up" samples in the day (gates avgMs). */
  up: number;
  /** Average response time for the day. */
  ping: number;
};

export type RollUpDayResult = {
  date: string;
  state: "operational" | "maintenance" | "degraded" | "major_outage";
  severity: "none" | "minor" | "major";
  uptime: number;
  downMinutes: number;
  avgMs: number | null;
};

export function rollUpDay(input: RollUpDayInput): RollUpDayResult {
  const { start, intervals, up, ping, maintenance = 0 } = input;
  const end = start + 86_400;
  const downSeconds = overlapSeconds(intervals, start, end);
  const longestDown = longestOverlapSeconds(intervals, start, end);
  const severity =
    downSeconds > 0 ? (longestDown >= SUSTAINED_DOWN_SECONDS ? "major" : "minor") : "none";
  const state =
    severity === "major"
      ? "major_outage"
      : severity === "minor"
        ? "degraded"
        : maintenance > 0
          ? "maintenance"
          : "operational";
  return {
    date: new Date(start * 1000).toISOString().slice(0, 10),
    state,
    severity,
    uptime: Math.round((100 - (downSeconds / 86_400) * 100) * 1000) / 1000,
    downMinutes: Math.round(downSeconds / 60),
    avgMs: up > 0 && Number.isFinite(ping) && ping >= 0 ? Math.round(ping * 100) / 100 : null,
  };
}
