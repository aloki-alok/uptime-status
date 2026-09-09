import { createHash } from "node:crypto";
import type { DeploymentInputs } from "./inputs";

export type DeploymentNames = {
  base: string;
  stack: string;
  publicBucket: string;
  stateTable: string;
  snapshotDeadLetterQueue: string;
  deliveryQueue: string;
  deliveryDeadLetterQueue: string;
  publisherFunction: string;
  publicApiFunction: string;
  adminApiFunction: string;
  senderFunction: string;
  metricNamespace: string;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function bounded(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  const suffix = digest(value);
  return `${value.slice(0, maximum - suffix.length - 1)}-${suffix}`;
}

export function createDeploymentNames(
  input: Pick<DeploymentInputs, "siteId" | "environment" | "aws">,
): DeploymentNames {
  const base = `uptime-status-${input.siteId}-${input.environment}`;
  const unique = `${base}-${input.aws.accountId}-${input.aws.region}`;

  return {
    base,
    stack: bounded(`${base}-core`, 128),
    publicBucket: bounded(unique, 63),
    stateTable: bounded(`${base}-state`, 255),
    snapshotDeadLetterQueue: bounded(`${base}-snapshot-dlq`, 80),
    deliveryQueue: bounded(`${base}-delivery`, 80),
    deliveryDeadLetterQueue: bounded(`${base}-delivery-dlq`, 80),
    publisherFunction: bounded(`${base}-publisher`, 64),
    publicApiFunction: bounded(`${base}-public-api`, 64),
    adminApiFunction: bounded(`${base}-admin-api`, 64),
    senderFunction: bounded(`${base}-sender`, 64),
    metricNamespace: `UptimeStatus/${input.siteId}/${input.environment}`,
  };
}
