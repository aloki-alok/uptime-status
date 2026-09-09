import {
  gateEvidencePasses,
  type ReleaseEvidence,
  type ReleaseGateId,
  releaseIsReady,
} from "./gates";
import type { DeploymentInputs } from "./inputs";

export type DeploymentStageId =
  | "validate-inputs"
  | "build-artifacts"
  | "review-infrastructure"
  | "apply-core-stack"
  | "preview-history-import"
  | "apply-history-import"
  | "verify-history-import"
  | "seed-status-snapshot"
  | "verify-independent-read-path"
  | "enable-subscription-acceptance"
  | "enable-notification-fanout"
  | "attach-custom-domain"
  | "cut-over-dns";

export type DeploymentStage = {
  id: DeploymentStageId;
  mutation: "none" | "preview" | "production";
  requiredGates: ReleaseGateId[];
  blockedBy: ReleaseGateId[];
  ready: boolean;
};

function stage(
  id: DeploymentStageId,
  mutation: DeploymentStage["mutation"],
  requiredGates: ReleaseGateId[],
  input: DeploymentInputs,
  evidence: ReleaseEvidence,
): DeploymentStage {
  const effectiveGates =
    mutation === "production" && !requiredGates.includes("production-approval")
      ? [...requiredGates, "production-approval" as const]
      : requiredGates;
  const blockedBy = effectiveGates.filter(
    (gate) => !gateEvidencePasses(input, evidence[gate], gate),
  );
  return { id, mutation, requiredGates: effectiveGates, blockedBy, ready: blockedBy.length === 0 };
}

export function createDeploymentPlan(
  input: DeploymentInputs,
  evidence: ReleaseEvidence = {},
): DeploymentStage[] {
  const mutation = input.environment;
  const buildGates: ReleaseGateId[] = [
    "quality-suite",
    "site-isolation",
    "production-build",
    "immutable-image",
  ];
  const infrastructureGates: ReleaseGateId[] = [...buildGates, "infrastructure-plan-reviewed"];
  const readPathGates: ReleaseGateId[] = [
    ...infrastructureGates,
    "preview-read-path",
    "private-origin",
    "stale-source-failure",
    "invalid-snapshot-rejection",
  ];
  const plan: DeploymentStage[] = [
    stage("validate-inputs", "none", [], input, evidence),
    stage("build-artifacts", "none", ["quality-suite", "site-isolation"], input, evidence),
    stage("review-infrastructure", "none", infrastructureGates, input, evidence),
    stage("apply-core-stack", mutation, infrastructureGates, input, evidence),
  ];
  const historyGates: ReleaseGateId[] = [];
  if (input.historyMigration.mode === "required") {
    plan.push(
      stage("preview-history-import", "none", infrastructureGates, input, evidence),
      stage(
        "apply-history-import",
        mutation,
        [...infrastructureGates, "history-import-preview-reviewed"],
        input,
        evidence,
      ),
      stage(
        "verify-history-import",
        mutation,
        [...infrastructureGates, "history-import-preview-reviewed", "history-import-applied"],
        input,
        evidence,
      ),
    );
    historyGates.push(
      "history-import-preview-reviewed",
      "history-import-applied",
      "history-import-verified",
    );
  }
  plan.push(
    stage(
      "seed-status-snapshot",
      mutation,
      [...infrastructureGates, ...historyGates],
      input,
      evidence,
    ),
    stage(
      "verify-independent-read-path",
      mutation,
      [...readPathGates, ...historyGates],
      input,
      evidence,
    ),
  );

  if (input.delivery.subscriptionsEnabled) {
    plan.push(
      stage(
        "enable-subscription-acceptance",
        mutation,
        [
          ...readPathGates,
          "subscription-lifecycle",
          "sender-kill-switch",
          "verified-recipient-delivery",
        ],
        input,
        evidence,
      ),
    );
  }
  if (input.delivery.fanoutEnabled) {
    plan.push(
      stage(
        "enable-notification-fanout",
        mutation,
        [
          ...readPathGates,
          "subscription-lifecycle",
          "sender-kill-switch",
          "verified-recipient-delivery",
          "ses-production-access",
          "feedback-suppression",
          "delivery-replay",
        ],
        input,
        evidence,
      ),
    );
  }
  if (input.environment === "production") {
    plan.push(
      stage(
        "attach-custom-domain",
        "production",
        [
          ...readPathGates,
          ...historyGates,
          ...(input.historyMigration.mode === "required"
            ? (["history-import-rollback-tested"] as const)
            : []),
          "backup-restore-drill",
          "legacy-status-ready",
          "production-approval",
        ],
        input,
        evidence,
      ),
      stage(
        "cut-over-dns",
        "production",
        [
          ...readPathGates,
          ...historyGates,
          ...(input.historyMigration.mode === "required"
            ? (["history-import-rollback-tested"] as const)
            : []),
          "backup-restore-drill",
          "legacy-status-ready",
          "dns-rollback-tested",
          "production-approval",
        ],
        input,
        evidence,
      ),
    );
  }

  return plan;
}

export function deploymentIsReady(input: DeploymentInputs, evidence: ReleaseEvidence) {
  return (
    releaseIsReady(input, evidence) &&
    createDeploymentPlan(input, evidence).every((item) => item.ready)
  );
}
