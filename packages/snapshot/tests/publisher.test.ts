import { describe, expect, test } from "bun:test";
import { type StatusSnapshot, validateStatusSnapshot } from "@uptime-status/domain";
import { NoLastKnownGoodSnapshotError, type ProbeComponent, publishProbeSnapshot } from "../src";

const component: ProbeComponent = {
  slug: "public-api",
  name: "Public API",
  group: "Services",
  url: "https://health.example.test/status",
};

function clock(...values: string[]) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] as string);
}

describe("HTTPS probe snapshot publisher", () => {
  test("publishes a valid snapshot with unknown history before the first observation", async () => {
    const published: StatusSnapshot[] = [];
    const result = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async (snapshot) => {
        published.push(snapshot);
      },
      fetch: async () => new Response(null, { status: 204 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.127Z"),
    });

    expect(result.kind).toBe("published");
    expect(validateStatusSnapshot(result.snapshot)).toBe(true);
    expect(published).toEqual([result.snapshot]);
    expect(result.snapshot.overallStatus).toBe("operational");
    expect(result.snapshot.components[0]?.responseTimeMs).toBe(127);
    expect(result.snapshot.components[0]?.history).toHaveLength(90);
    expect(
      result.snapshot.components[0]?.history
        .slice(0, 89)
        .every((day) => day.state === "unknown" && day.uptime === null && day.avgMs === null),
    ).toBe(true);
    expect(result.snapshot.components[0]?.history.at(-1)).toEqual({
      date: "2026-09-09",
      state: "operational",
      severity: "none",
      uptime: null,
      downMinutes: 0,
      avgMs: null,
    });
    expect(JSON.stringify(result.snapshot)).not.toContain(component.url);
  });

  test("publishes an HTTP error as an observed outage", async () => {
    const result = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 503 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.050Z"),
    });

    expect(result.kind).toBe("published");
    expect(result.snapshot.overallStatus).toBe("major_outage");
    expect(result.snapshot.components[0]?.state).toBe("major_outage");
    expect(result.snapshot.components[0]?.history.at(-1)?.uptime).toBeNull();
    expect(validateStatusSnapshot(result.snapshot)).toBe(true);
  });

  test("keeps truthful minute-bucket latency without filling missed checks", async () => {
    const measured = { ...component, showLatency: true };
    const first = await publishProbeSnapshot(measured, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T10:00:10.000Z", "2026-09-09T10:00:10.080Z"),
    });
    const second = await publishProbeSnapshot(measured, {
      readCurrent: async () => first.snapshot,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T10:02:20.000Z", "2026-09-09T10:02:20.140Z"),
    });

    expect(second.snapshot.components[0]?.latency).toEqual([
      { observedAt: "2026-09-09T10:00:00.000Z", avgMs: 80, p95Ms: 80 },
      { observedAt: "2026-09-09T10:02:00.000Z", avgMs: 140, p95Ms: 140 },
    ]);
    expect(validateStatusSnapshot(second.snapshot)).toBe(true);
  });

  test("treats a redirect as an observed outage instead of following it", async () => {
    let redirectMode: RequestRedirect | undefined;
    const result = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async (_url, init) => {
        redirectMode = init.redirect;
        return new Response(null, { status: 302 });
      },
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.020Z"),
    });

    expect(redirectMode).toBe("manual");
    expect(result.snapshot.overallStatus).toBe("major_outage");
  });

  test("rolls the window forward without replacing earlier observed days", async () => {
    const first = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.020Z"),
    });
    const second = await publishProbeSnapshot(component, {
      readCurrent: async () => first.snapshot,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 503 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.030Z"),
    });

    expect(second.snapshot.components[0]?.history.slice(-2).map((day) => day.state)).toEqual([
      "operational",
      "major_outage",
    ]);
    expect(second.snapshot.components[0]?.history).toHaveLength(90);
  });

  test("does not erase an outage observed earlier on the same UTC day", async () => {
    const outage = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 503 }),
      now: clock("2026-09-09T09:00:00.000Z", "2026-09-09T09:00:00.010Z"),
    });
    const recovered = await publishProbeSnapshot(component, {
      readCurrent: async () => outage.snapshot,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.010Z"),
    });

    expect(recovered.snapshot.components[0]?.state).toBe("operational");
    expect(recovered.snapshot.components[0]?.history.at(-1)?.state).toBe("major_outage");
  });

  test("retains the last-known-good snapshot when the clock would regress freshness", async () => {
    const first = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.010Z"),
    });
    let published = false;
    const result = await publishProbeSnapshot(component, {
      readCurrent: async () => first.snapshot,
      publish: async () => {
        published = true;
      },
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T09:00:00.000Z", "2026-09-09T09:00:00.010Z"),
    });

    expect(result).toEqual({
      kind: "retained",
      snapshot: first.snapshot,
      reason: "non-monotonic-observation",
    });
    expect(published).toBe(false);
  });

  test("retains the exact last-known-good snapshot on transport failure", async () => {
    const published: StatusSnapshot[] = [];
    const first = await publishProbeSnapshot(component, {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => new Response(null, { status: 200 }),
      now: clock("2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00.010Z"),
    });
    const result = await publishProbeSnapshot(component, {
      readCurrent: async () => first.snapshot,
      publish: async (snapshot) => {
        published.push(snapshot);
      },
      fetch: async () => {
        throw new TypeError("network unavailable");
      },
    });

    expect(result).toEqual({
      kind: "retained",
      snapshot: first.snapshot,
      reason: "probe-unavailable",
    });
    expect(published).toHaveLength(0);
  });

  test("fails closed when the first probe has no last-known-good snapshot", async () => {
    expect(
      publishProbeSnapshot(component, {
        readCurrent: async () => null,
        publish: async () => {},
        fetch: async () => {
          throw new TypeError("network unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(NoLastKnownGoodSnapshotError);
  });

  test("rejects non-HTTPS probe URLs before reading or publishing state", async () => {
    let read = false;
    await expect(
      publishProbeSnapshot(
        { ...component, url: "http://health.example.test/status" },
        {
          readCurrent: async () => {
            read = true;
            return null;
          },
          publish: async () => {},
        },
      ),
    ).rejects.toThrow("must be HTTPS");
    expect(read).toBe(false);
  });
});
