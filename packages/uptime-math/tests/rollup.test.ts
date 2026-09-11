import { describe, expect, test } from "bun:test";
import { confirmedDownIntervals, rollUpDay } from "../src";

const DAY = 86_400;
const START = 1_788_220_800; // 2026-09-01T00:00:00Z (UTC day boundary)

describe("rollUpDay", () => {
  test("fully-up day is operational with 100% uptime", () => {
    const rows = [
      { timestamp: START, status: 1 },
      { timestamp: START + DAY - 60, status: 1 },
    ];
    const intervals = confirmedDownIntervals(rows, START, START + DAY);
    const result = rollUpDay({ start: START, intervals, up: 100, ping: 120 });

    expect(result).toEqual({
      date: "2026-09-01",
      state: "operational",
      severity: "none",
      uptime: 100,
      downMinutes: 0,
      avgMs: 120,
    });
  });

  test("isolated failed check under threshold is a minor degradation", () => {
    const rows = [
      { timestamp: START, status: 1 },
      { timestamp: START + 100, status: 0 },
      { timestamp: START + 130, status: 1 },
    ];
    const intervals = confirmedDownIntervals(rows, START, START + DAY);
    const result = rollUpDay({ start: START, intervals, up: 99, ping: 110 });

    expect(result.severity).toBe("minor");
    expect(result.state).toBe("degraded");
    expect(result.downMinutes).toBe(1);
    expect(result.uptime).toBe(Math.round((100 - (30 / DAY) * 100) * 1000) / 1000);
  });

  test("sustained outage over 600s is a major outage", () => {
    const rows = [
      { timestamp: START, status: 1 },
      { timestamp: START + 200, status: 0 },
      { timestamp: START + 200 + 700, status: 1 },
    ];
    const intervals = confirmedDownIntervals(rows, START, START + DAY);
    const result = rollUpDay({ start: START, intervals, up: 90, ping: 150 });

    expect(result.severity).toBe("major");
    expect(result.state).toBe("major_outage");
    expect(result.downMinutes).toBe(Math.round(700 / 60));
  });

  test("short outage under 600s is a minor degradation", () => {
    const rows = [
      { timestamp: START, status: 1 },
      { timestamp: START + 200, status: 0 },
      { timestamp: START + 200 + 300, status: 1 },
    ];
    const intervals = confirmedDownIntervals(rows, START, START + DAY);
    const result = rollUpDay({ start: START, intervals, up: 95, ping: 130 });

    expect(result.severity).toBe("minor");
    expect(result.state).toBe("degraded");
    expect(result.downMinutes).toBe(5);
  });
});
