import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAndValidateSite, validateSiteInput } from "../src/validation";

const template = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../templates/status.config.json"), "utf8"),
);

describe("site validation", () => {
  test("accepts the package-owned production template", () => {
    expect(validateSiteInput(template).ok).toBe(true);
  });

  test("reports malformed JSON", () => {
    const result = parseAndValidateSite("{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatchObject({ kind: "json", path: "/" });
  });

  test("reports field-level schema errors", () => {
    const result = validateSiteInput({ ...template, siteId: "Not valid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ kind: "schema", path: "/siteId" }),
      );
    }
  });

  test("reports field-level semantic errors", () => {
    const result = validateSiteInput({
      ...template,
      monitoring: { ...template.monitoring, staleAfterSeconds: 60 },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: "semantic",
          path: "/monitoring/staleAfterSeconds",
          message: "must be at least two polling intervals",
        },
      ],
    });
  });
});
