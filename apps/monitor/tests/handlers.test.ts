import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStatusSnapshot } from "@uptime-status/domain";
import { MonitorStore } from "@uptime-status/monitor";
import { createCheckHandler, createPublisher } from "../src/handlers";
import { createCloudflareKvSink, createFilesystemSink } from "../src/sink";
import { buildMonitorTargets } from "../src/targets";
import { testSite } from "./fixtures";

function fakeFetch(status: number) {
  return (async () => new Response(null, { status })) as unknown as typeof fetch;
}

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "monitor-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("createCheckHandler", () => {
  test("records a check result and rolls up the day", async () => {
    const store = new MonitorStore(new Database(":memory:"));
    const now = () => new Date("2026-09-10T12:00:00.000Z");
    const target = buildMonitorTargets(testSite())[0];
    const handleCheck = createCheckHandler({ store, fetchImpl: fakeFetch(200), now });

    await handleCheck(target);

    const checks = store.db
      .query("SELECT * FROM checks WHERE component_id = ?")
      .all("public-api") as { status: number }[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe(1);

    const days = store.readDays("public-api", "2026-09-10", "2026-09-10");
    expect(days).toHaveLength(1);
    expect(days[0].state).toBe("operational");
  });
});

describe("createPublisher", () => {
  test("publish writes current.json as a valid snapshot", async () => {
    const store = new MonitorStore(new Database(":memory:"));
    const now = () => new Date("2026-09-10T12:00:00.000Z");
    const site = testSite();
    const target = buildMonitorTargets(site)[0];
    await createCheckHandler({ store, fetchImpl: fakeFetch(200), now })(target);

    const dir = tempDir();
    const publish = createPublisher({ store, site, sink: createFilesystemSink(dir), now });
    await publish();

    const body = readFileSync(join(dir, "current.json"), "utf8");
    const snapshot = JSON.parse(body);
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("a sink that throws does not stop the loop", async () => {
    const store = new MonitorStore(new Database(":memory:"));
    const site = testSite();
    const logs: Record<string, unknown>[] = [];
    const publish = createPublisher({
      store,
      site,
      sink: { publish: async () => Promise.reject(new Error("disk full")) },
      log: (line) => logs.push(line),
    });

    await expect(publish()).resolves.toBeUndefined();
    await expect(publish()).resolves.toBeUndefined();
    expect(logs.filter((line) => line.kind === "publish.sink_failed")).toHaveLength(2);
  });

  test("a snapshot build failure leaves the previously written file untouched", async () => {
    const store = new MonitorStore(new Database(":memory:"));
    const now = () => new Date("2026-09-10T12:00:00.000Z");
    const site = testSite();
    const target = buildMonitorTargets(site)[0];
    await createCheckHandler({ store, fetchImpl: fakeFetch(200), now })(target);

    const dir = tempDir();
    const sink = createFilesystemSink(dir);
    const goodPublish = createPublisher({ store, site, sink, now });
    await goodPublish();
    const before = readFileSync(join(dir, "current.json"), "utf8");

    const logs: Record<string, unknown>[] = [];
    const brokenPublish = createPublisher({
      store,
      site,
      sink,
      now,
      log: (line) => logs.push(line),
      buildSnapshot: () => {
        throw new Error("contract violation");
      },
    });
    await brokenPublish();

    const after = readFileSync(join(dir, "current.json"), "utf8");
    expect(after).toBe(before);
    expect(logs.filter((line) => line.kind === "publish.build_failed")).toHaveLength(1);
  });
});

describe("createCloudflareKvSink", () => {
  test("writes the immutable revision before the current pointer", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      return new Response('{"success":true}', { status: 200 });
    }) as typeof fetch;
    const sink = createCloudflareKvSink({
      accountId: "account",
      namespaceId: "namespace",
      apiToken: "secret",
      siteId: "example-service",
      fetchImpl,
    });
    const body = JSON.stringify({ sourceRevision: "revision-1" });

    await sink.publish("current.json", body);

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toEndWith(
      "/values/sites%2Fexample-service%2Fsnapshots%2Frevision-1.json",
    );
    expect(requests[1].url).toEndWith("/values/sites%2Fexample-service%2Fcurrent.json");
    expect(requests.every((request) => request.method === "PUT" && request.body === body)).toBe(
      true,
    );
  });

  test("does not advance current when the immutable write fails", async () => {
    let calls = 0;
    const sink = createCloudflareKvSink({
      accountId: "account",
      namespaceId: "namespace",
      apiToken: "secret",
      siteId: "example-service",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("denied", { status: 403 });
      }) as unknown as typeof fetch,
    });

    await expect(sink.publish("current.json", '{"sourceRevision":"revision-1"}')).rejects.toThrow(
      "Cloudflare KV publish failed",
    );
    expect(calls).toBe(1);
  });
});
