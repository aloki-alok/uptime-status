import { describe, expect, test } from "bun:test";
import { createWorker } from "../src/handler";
import worker from "../src/index";
import { runPublisher } from "../src/publisher";

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly options = new Map<string, KVNamespacePutOptions | undefined>();
  readonly writes: string[] = [];

  async get(key: string, type?: "text" | "json") {
    const value = this.values.get(key) ?? null;
    if (type === "json" && value !== null) return JSON.parse(value);
    return value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions) {
    this.writes.push(key);
    this.values.set(key, value);
    this.options.set(key, options);
  }
}

function testEnv(kv = new MemoryKv()) {
  return {
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    },
    STATUS: kv,
    SITE_ID: "example-site",
    TARGET_URL: "https://example.com/",
    COMPONENT_SLUG: "website",
    COMPONENT_NAME: "Website",
    COMPONENT_GROUP: "Website",
    SHOW_LATENCY: "true",
    POLL_INTERVAL_SECONDS: "60",
  } as Env;
}

describe("Cloudflare status worker", () => {
  test("fails closed while the first snapshot is unavailable", async () => {
    const response = await worker.fetch(
      new Request("https://status.example.com/current.json"),
      testEnv(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "status-initializing" });
  });

  test("serves the current snapshot without caching and delegates static assets", async () => {
    const kv = new MemoryKv();
    await runPublisher(testEnv(kv), async () => new Response("ok", { status: 200 }));
    const env = testEnv(kv);

    const current = await worker.fetch(new Request("https://status.example.com/current.json"), env);
    const asset = await worker.fetch(new Request("https://status.example.com/"), env);

    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    expect(current.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await current.json()).schemaVersion).toBe("1.0.0");
    expect(await asset.text()).toBe("asset");
    expect(asset.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(asset.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://static.cloudflareinsights.com",
    );
  });

  test("refreshes a stale snapshot before returning it", async () => {
    const kv = new MemoryKv();
    await runPublisher(testEnv(kv), async () => new Response("ok", { status: 200 }));
    const currentKey = "sites/example-site/current.json";
    const stale = JSON.parse(kv.values.get(currentKey) ?? "{}");
    stale.latestCheckAt = "2026-01-01T00:00:00.000Z";
    stale.components[0].latestObservedAt = "2026-01-01T00:00:00.000Z";
    stale.components[0].latency[0].observedAt = "2026-01-01T00:00:00.000Z";
    kv.values.set(currentKey, JSON.stringify(stale));
    let probes = 0;
    const refreshingWorker = createWorker(async () => {
      probes += 1;
      return new Response("ok", { status: 200 });
    });

    const response = await refreshingWorker.fetch(
      new Request("https://status.example.com/current.json"),
      testEnv(kv),
    );
    const snapshot = await response.json();

    expect(response.status).toBe(200);
    expect(probes).toBe(1);
    expect(snapshot.latestCheckAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("rejects malformed stored state", async () => {
    const kv = new MemoryKv();
    kv.values.set("sites/example-site/current.json", "{}");

    const response = await worker.fetch(
      new Request("https://status.example.com/current.json"),
      testEnv(kv),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  test("publishes a fresh probe atomically after the immutable revision", async () => {
    const kv = new MemoryKv();
    const env = testEnv(kv);
    const fetcher: typeof globalThis.fetch = async () => new Response("ok", { status: 200 });

    const result = await runPublisher(env, fetcher);

    expect(result.kind).toBe("published");
    const revisionKey = `sites/example-site/snapshots/${result.snapshot.sourceRevision}.json`;
    expect(kv.values.has(revisionKey)).toBe(true);
    expect(kv.values.get("sites/example-site/current.json")).toBe(kv.values.get(revisionKey));
    expect(kv.options.get(revisionKey)?.expirationTtl).toBe(90 * 24 * 60 * 60);
    expect(kv.options.get("sites/example-site/current.json")).toBeUndefined();
    expect(kv.writes).toEqual([revisionKey, "sites/example-site/current.json"]);
    expect(result.snapshot.components[0].latency).toHaveLength(1);
  });

  test("retains current state when a later probe cannot connect", async () => {
    const kv = new MemoryKv();
    const env = testEnv(kv);
    await runPublisher(env, async () => new Response("ok", { status: 200 }));
    const current = kv.values.get("sites/example-site/current.json");

    const result = await runPublisher(env, async () => {
      throw new TypeError("network unavailable");
    });

    expect(result.kind).toBe("retained");
    expect(kv.values.get("sites/example-site/current.json")).toBe(current);
  });
});
