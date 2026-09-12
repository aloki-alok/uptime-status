import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MonitorStore } from "@uptime-status/monitor";
import { createMonitorApp } from "../src/app";
import { testSite } from "./fixtures";

// Fake timers that only track handles; nothing ever fires, so this test can't hang.
function fakeTimers() {
  let nextId = 1;
  const active = new Set<number>();
  return {
    setTimeoutImpl: (_callback: () => void, _ms: number) => {
      const id = nextId++;
      active.add(id);
      return id;
    },
    clearTimeoutImpl: (handle: unknown) => {
      active.delete(handle as number);
    },
    active,
  };
}

describe("createMonitorApp", () => {
  test("shutdown stops the scheduler and clears every timer it started", () => {
    const timers = fakeTimers();
    const store = new MonitorStore(new Database(":memory:"));
    const app = createMonitorApp({
      site: testSite(),
      store,
      sink: { publish: async () => {} },
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });

    app.start();
    expect(timers.active.size).toBeGreaterThan(0); // one https target + publish loop + prune loop

    app.stop();
    expect(timers.active.size).toBe(0);
  });
});
