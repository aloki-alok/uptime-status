import { describe, expect, test } from "bun:test";
import { check } from "../src/checker";

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  return (async () => {
    const responder = responses[Math.min(call, responses.length - 1)];
    call++;
    return responder();
  }) as unknown as typeof fetch;
}

describe("check", () => {
  test("200 is up", async () => {
    const fetchImpl = fakeFetch([() => new Response(null, { status: 200 })]);
    const result = await check({ url: "https://example.com" }, fetchImpl);
    expect(result.status).toBe(1);
    expect(result.httpStatus).toBe(200);
  });

  test("500 is down after retries", async () => {
    const fetchImpl = fakeFetch([() => new Response(null, { status: 500 })]);
    const result = await check({ url: "https://example.com", confirmRetries: 2 }, fetchImpl);
    expect(result.status).toBe(0);
    expect(result.httpStatus).toBe(500);
  });

  test("a single transient failure followed by success is up, not down", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) throw new Error("network blip");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await check({ url: "https://example.com", confirmRetries: 1 }, fetchImpl);
    expect(result.status).toBe(1);
    expect(call).toBe(2);
  });

  test("timeout is down", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
      });
    }) as unknown as typeof fetch;

    const result = await check(
      { url: "https://example.com", timeoutMs: 5, confirmRetries: 0 },
      fetchImpl,
    );
    expect(result.status).toBe(0);
  });

  test("a 301 in acceptedStatus is up", async () => {
    const fetchImpl = fakeFetch([() => new Response(null, { status: 301 })]);
    const result = await check({ url: "https://example.com", acceptedStatus: ["301"] }, fetchImpl);
    expect(result.status).toBe(1);
  });

  test("never throws for an unreachable target", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await check({ url: "https://example.com", confirmRetries: 0 }, fetchImpl);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
