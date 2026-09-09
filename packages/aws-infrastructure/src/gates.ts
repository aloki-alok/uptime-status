import type { DeploymentInputs } from "./inputs";

export const releaseGateIds = [
  "quality-suite",
  "site-isolation",
  "production-build",
  "immutable-image",
  "infrastructure-plan-reviewed",
  "preview-read-path",
  "private-origin",
  "stale-source-failure",
  "invalid-snapshot-rejection",
  "backup-restore-drill",
  "history-import-preview-reviewed",
  "history-import-applied",
  "history-import-verified",
  "history-import-rollback-tested",
  "subscription-lifecycle",
  "sender-kill-switch",
  "verified-recipient-delivery",
  "ses-production-access",
  "feedback-suppression",
  "delivery-replay",
  "legacy-status-ready",
  "dns-rollback-tested",
  "production-approval",
] as const;

export type ReleaseGateId = (typeof releaseGateIds)[number];
export type GateState = "missing" | "passed" | "failed";

export type GateEvidence = {
  state: GateState;
  checkedAt?: string;
  proof?: string;
  artifactRevision?: string;
  siteId?: string;
  topologyRevision?: string;
  importId?: string;
  bundleSha256?: string;
};

export type ReleaseEvidence = Partial<Record<ReleaseGateId, GateEvidence>>;

export type EvaluatedGate = {
  id: ReleaseGateId;
  required: boolean;
  state: GateState;
};

const BASE_GATES: ReleaseGateId[] = [
  "quality-suite",
  "site-isolation",
  "production-build",
  "immutable-image",
  "infrastructure-plan-reviewed",
];

const READ_PATH_GATES: ReleaseGateId[] = [
  "preview-read-path",
  "private-origin",
  "stale-source-failure",
  "invalid-snapshot-rejection",
];

const SUBSCRIPTION_GATES: ReleaseGateId[] = [
  "subscription-lifecycle",
  "sender-kill-switch",
  "verified-recipient-delivery",
];

const FANOUT_GATES: ReleaseGateId[] = [
  "ses-production-access",
  "feedback-suppression",
  "delivery-replay",
];

const PRODUCTION_GATES: ReleaseGateId[] = [
  "backup-restore-drill",
  "legacy-status-ready",
  "dns-rollback-tested",
  "production-approval",
];

export const historyReleaseGateIds = [
  "history-import-preview-reviewed",
  "history-import-applied",
  "history-import-verified",
  "history-import-rollback-tested",
] as const satisfies readonly ReleaseGateId[];

export function requiredReleaseGates(input: DeploymentInputs): ReleaseGateId[] {
  const required = [...BASE_GATES, ...READ_PATH_GATES];
  if (input.delivery.subscriptionsEnabled) required.push(...SUBSCRIPTION_GATES);
  if (input.delivery.fanoutEnabled) required.push(...FANOUT_GATES);
  if (input.historyMigration.mode === "required") {
    required.push(...historyReleaseGateIds.slice(0, 3));
    if (input.environment === "production") required.push("history-import-rollback-tested");
  }
  if (input.environment === "production") required.push(...PRODUCTION_GATES);
  return [...new Set(required)];
}

export function evaluateReleaseGates(
  input: DeploymentInputs,
  evidence: ReleaseEvidence,
): EvaluatedGate[] {
  const required = new Set(requiredReleaseGates(input));
  return releaseGateIds.map((id) => ({
    id,
    required: required.has(id),
    state: gateEvidencePasses(input, evidence[id], id)
      ? "passed"
      : (evidence[id]?.state ?? "missing"),
  }));
}

export function gateEvidencePasses(
  input: DeploymentInputs,
  evidence?: GateEvidence,
  gateId?: ReleaseGateId,
) {
  const basePasses =
    evidence?.state === "passed" &&
    typeof evidence.checkedAt === "string" &&
    !Number.isNaN(Date.parse(evidence.checkedAt)) &&
    typeof evidence.proof === "string" &&
    evidence.proof.trim().length > 0 &&
    evidence.artifactRevision === input.build.platformRevision;
  if (!basePasses) return false;
  if (
    !gateId ||
    !historyReleaseGateIds.includes(gateId as (typeof historyReleaseGateIds)[number])
  ) {
    return true;
  }
  return (
    input.historyMigration.mode === "required" &&
    evidence.siteId === input.siteId &&
    evidence.topologyRevision === input.historyMigration.topologyRevision &&
    evidence.importId === input.historyMigration.importId &&
    evidence.bundleSha256 === input.historyMigration.bundleSha256
  );
}

export function releaseIsReady(input: DeploymentInputs, evidence: ReleaseEvidence) {
  return evaluateReleaseGates(input, evidence).every(
    (gate) => !gate.required || gate.state === "passed",
  );
}
