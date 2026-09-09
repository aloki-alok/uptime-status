import { describe, expect, test } from "bun:test";
import { createIncidentFixture, createStatusFixture } from "../src/fixture";
import { validateStatusSnapshot } from "../src/schema";
import { deriveOverallStatus, isSnapshotFresh } from "../src/truth";

describe("status snapshot contract", () => {
  test("accepts the complete 90-day fixture", () => {
    const snapshot = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });

    expect(validateStatusSnapshot(snapshot)).toBe(true);
    expect(snapshot.components.every((component) => component.history.length === 90)).toBe(true);
    expect(snapshot.components.filter((component) => component.latency !== null)).toHaveLength(1);
    expect(
      snapshot.components.find((component) => component.slug === "public-api")?.latency,
    ).toHaveLength(60);
  });

  test("rejects unknown fields to prevent accidental source leakage", () => {
    const snapshot = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });
    const unsafe = { ...snapshot, internalMonitorUrl: "https://internal.invalid" };

    expect(validateStatusSnapshot(unsafe)).toBe(false);
  });

  test("rejects invalid calendar dates and timestamps without a timezone", () => {
    const invalidDate = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });
    invalidDate.components[0].history[0].date = "2026-02-30";

    const missingTimezone = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });
    missingTimezone.generatedAt = "2026-09-07T10:00:00";

    expect(validateStatusSnapshot(invalidDate)).toBe(false);
    expect(validateStatusSnapshot(missingTimezone)).toBe(false);
  });

  test("rejects broken ordering, references, and optimistic overall status", () => {
    const duplicateDays = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });
    duplicateDays.components[0].history[1].date = duplicateDays.components[0].history[0].date;

    const unknownReference = createStatusFixture({ generatedAt: "2026-09-07T10:00:00.000Z" });
    unknownReference.scheduledMaintenance[0].affectedComponents = ["private-monitor"];

    const falseHealthy = createStatusFixture({
      generatedAt: "2026-09-07T10:00:00.000Z",
      activeIncidentImpact: "major_outage",
    });
    falseHealthy.overallStatus = "operational";

    expect(validateStatusSnapshot(duplicateDays)).toBe(false);
    expect(validateStatusSnapshot(unknownReference)).toBe(false);
    expect(validateStatusSnapshot(falseHealthy)).toBe(false);
  });
});

describe("overall status truth merge", () => {
  test("stale data overrides a healthy source claim", () => {
    expect(
      deriveOverallStatus({
        isFresh: false,
        componentStates: ["operational"],
        activeIncidents: [],
      }),
    ).toBe("unknown");
  });

  test("uses the response time to detect two missed publication windows", () => {
    const snapshot = {
      generatedAt: "2026-09-07T10:00:30.000Z",
      latestCheckAt: "2026-09-07T10:00:00.000Z",
    };

    expect(isSnapshotFresh(snapshot, "2026-09-07T10:01:59.000Z")).toBe(true);
    expect(isSnapshotFresh(snapshot, "2026-09-07T10:02:01.000Z")).toBe(false);
  });

  test("an active incident overrides operational components", () => {
    const snapshot = createStatusFixture({
      generatedAt: "2026-09-07T10:00:00.000Z",
      activeIncidentImpact: "major_outage",
    });

    expect(snapshot.overallStatus).toBe("major_outage");
  });

  test("resolved incidents do not override current component health", () => {
    const incident = createIncidentFixture("2026-09-07T10:00:00.000Z");
    incident.state = "resolved";
    incident.resolvedAt = "2026-09-07T10:00:00.000Z";

    expect(
      deriveOverallStatus({
        isFresh: true,
        componentStates: ["operational"],
        activeIncidents: [incident],
      }),
    ).toBe("operational");
  });

  test("the worst component state wins without an incident", () => {
    expect(
      deriveOverallStatus({
        isFresh: true,
        componentStates: ["operational", "maintenance", "degraded"],
        activeIncidents: [],
      }),
    ).toBe("degraded");
  });
});
