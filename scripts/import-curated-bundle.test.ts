import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuratedStore } from "../apps/monitor/src/curated";
import { testSite } from "../apps/monitor/tests/fixtures";
import type { Incident } from "../packages/status-contract/src/index";

test("historical notice import opens the database for writes only with --apply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "status-curated-import-"));
  try {
    const site = testSite();
    const sitePath = join(directory, "site.json");
    const bundlePath = join(directory, "bundle.json");
    const databasePath = join(directory, "monitor.db");
    const startedAt = "2026-08-27T12:00:00.000Z";
    const resolvedAt = "2026-08-27T12:30:00.000Z";
    const incident: Incident = {
      slug: "resolved-api-incident",
      revision: 1,
      title: "API request failures",
      state: "resolved",
      impact: "partial_outage",
      affectedComponents: ["public-api"],
      startedAt,
      resolvedAt,
      updates: [
        {
          id: "started",
          state: "investigating",
          message: "We are investigating.",
          publishedAt: startedAt,
        },
        {
          id: "resolved",
          state: "resolved",
          message: "Requests recovered.",
          publishedAt: resolvedAt,
        },
      ],
    };
    await Bun.write(sitePath, JSON.stringify(site));
    await Bun.write(
      bundlePath,
      JSON.stringify({ schemaVersion: "1.0.0", incidents: [incident], maintenances: [] }),
    );
    const setup = new Database(databasePath, { create: true });
    new CuratedStore(setup, site);
    setup.close();

    async function run(apply: boolean) {
      const command = [
        process.execPath,
        join(import.meta.dir, "import-curated-bundle.ts"),
        "--site",
        sitePath,
        "--bundle",
        bundlePath,
        "--database",
        databasePath,
        ...(apply ? ["--apply"] : []),
      ];
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }

    expect((await run(false)).stdout).toContain("Dry run: 1 historical notices");
    const before = new Database(databasePath, { readonly: true });
    expect(before.query("SELECT COUNT(*) AS count FROM curated_events").get()).toEqual({
      count: 0,
    });
    before.close();

    const applied = await run(true);
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    expect(applied.stdout).toContain("Imported 1 historical notices.");
    const after = new Database(databasePath, { readonly: true });
    expect(after.query("SELECT kind, slug FROM curated_events").get()).toEqual({
      kind: "incident",
      slug: incident.slug,
    });
    expect(after.query("SELECT COUNT(*) AS count FROM curated_audit").get()).toEqual({ count: 1 });
    after.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
