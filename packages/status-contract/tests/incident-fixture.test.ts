import { describe, expect, test } from "bun:test";
import { createIncidentFixture, createStatusFixture } from "../src/index";

describe("incident fixture", () => {
  test("keeps a stable public route identity and chronological updates", () => {
    const incident = createIncidentFixture("2026-09-07T10:00:00.000Z");
    const updateTimes = incident.updates.map((update) => Date.parse(update.publishedAt));

    expect(incident.slug).toBe("elevated-api-latency");
    expect(new Set(incident.updates.map((update) => update.id)).size).toBe(incident.updates.length);
    expect(updateTimes).toEqual([...updateTimes].sort((left, right) => left - right));
  });

  test("uses the detail fixture in active status snapshots", () => {
    const snapshot = createStatusFixture({
      generatedAt: "2026-09-07T10:00:00.000Z",
      activeIncidentImpact: "major_outage",
    });

    expect(snapshot.activeIncidents[0]?.slug).toBe("elevated-api-latency");
    expect(snapshot.activeIncidents[0]?.impact).toBe("major_outage");
    expect(snapshot.activeIncidents[0]?.updates).toHaveLength(3);
  });
});
