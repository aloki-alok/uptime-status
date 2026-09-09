import { type SiteConfig, type SiteConfigIssue, siteConfigIssues } from "@uptime-status/domain";

export type ValidationIssue = SiteConfigIssue | { kind: "json"; path: string; message: string };

export type ValidationResult =
  | { ok: true; config: SiteConfig }
  | { ok: false; issues: ValidationIssue[] };

export function validateSiteInput(input: unknown): ValidationResult {
  const issues = siteConfigIssues(input);
  return issues.length === 0 ? { ok: true, config: input as SiteConfig } : { ok: false, issues };
}

export function parseAndValidateSite(text: string): ValidationResult {
  try {
    return validateSiteInput(JSON.parse(text));
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          kind: "json",
          path: "/",
          message: error instanceof Error ? error.message : "invalid JSON",
        },
      ],
    };
  }
}
