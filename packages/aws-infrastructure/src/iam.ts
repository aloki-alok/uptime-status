import type { DeploymentInputs } from "./inputs";

export const iamCapabilities = [
  "monitoring-secret:read",
  "subscription-secrets:read",
  "snapshot:read",
  "snapshot:write",
  "history:read",
  "history:write",
  "control:read",
  "control:write",
  "subscriber:read",
  "subscriber:write",
  "audit:append",
  "outbox:read",
  "outbox:write",
  "delivery:read",
  "delivery:write",
  "queue:dispatch",
  "queue:consume",
  "ses:send",
  "feedback:write",
  "metrics:write",
] as const;

export type IamCapability = (typeof iamCapabilities)[number];
export type RuntimeRoleId =
  | "publisher"
  | "history-importer"
  | "public-api"
  | "admin-api"
  | "outbox-dispatcher"
  | "sender"
  | "feedback";

export type IamRoleBoundary = {
  role: RuntimeRoleId;
  capabilities: IamCapability[];
  siteKeyPrefixes: string[];
  secretArns: string[];
};

const FORBIDDEN: Record<RuntimeRoleId, IamCapability[]> = {
  publisher: ["subscriber:read", "subscriber:write", "ses:send", "feedback:write"],
  "history-importer": [
    "monitoring-secret:read",
    "subscription-secrets:read",
    "control:write",
    "subscriber:read",
    "subscriber:write",
    "ses:send",
  ],
  "public-api": ["snapshot:write", "history:write", "control:write", "ses:send"],
  "admin-api": [
    "snapshot:write",
    "history:write",
    "subscriber:read",
    "subscriber:write",
    "ses:send",
  ],
  "outbox-dispatcher": ["snapshot:write", "control:write", "subscriber:write", "ses:send"],
  sender: ["snapshot:write", "history:write", "control:write", "subscriber:write"],
  feedback: ["snapshot:write", "history:write", "control:write", "ses:send"],
};

function prefix(input: DeploymentInputs, domain: string) {
  return `T#${input.siteId}#${domain}`;
}

export function createIamRoleBoundaries(input: DeploymentInputs): IamRoleBoundary[] {
  const roles: IamRoleBoundary[] = [
    {
      role: "publisher",
      capabilities: [
        "monitoring-secret:read",
        "snapshot:read",
        "snapshot:write",
        "history:read",
        "history:write",
        "control:read",
        "metrics:write",
      ],
      siteKeyPrefixes: [
        prefix(input, "OBS#"),
        prefix(input, "HISTORY#"),
        prefix(input, "CONTROL#"),
      ],
      secretArns: [input.monitoringSecretArn],
    },
    {
      role: "admin-api",
      capabilities: [
        "control:read",
        "control:write",
        "audit:append",
        "outbox:write",
        "metrics:write",
      ],
      siteKeyPrefixes: [
        prefix(input, "CONTROL#"),
        prefix(input, "PLAN#"),
        prefix(input, "COMMAND#"),
        prefix(input, "AUDIT#"),
        prefix(input, "OUTBOX#"),
      ],
      secretArns: [],
    },
  ];

  if (input.historyMigration.mode === "required") {
    roles.push({
      role: "history-importer",
      capabilities: [
        "history:read",
        "history:write",
        "snapshot:read",
        "audit:append",
        "metrics:write",
      ],
      siteKeyPrefixes: [
        prefix(input, "HISTORY#"),
        prefix(input, "IMPORT#"),
        prefix(input, "AUDIT#HISTORY#"),
      ],
      secretArns: [],
    });
  }

  if (!input.delivery.subscriptionsEnabled || !input.subscriptionSecretArns) return roles;

  roles.push(
    {
      role: "public-api",
      capabilities: [
        "subscription-secrets:read",
        "subscriber:read",
        "subscriber:write",
        "outbox:write",
        "metrics:write",
      ],
      siteKeyPrefixes: [
        prefix(input, "SUB#"),
        prefix(input, "CONFIRM#"),
        prefix(input, "RATE#"),
        prefix(input, "OUTBOX#CONFIRM#"),
      ],
      secretArns: Object.values(input.subscriptionSecretArns),
    },
    {
      role: "outbox-dispatcher",
      capabilities: ["outbox:read", "queue:dispatch", "subscriber:read", "metrics:write"],
      siteKeyPrefixes: [prefix(input, "OUTBOX#"), prefix(input, "SUB#")],
      secretArns: [],
    },
    {
      role: "sender",
      capabilities: [
        "subscription-secrets:read",
        "subscriber:read",
        "delivery:read",
        "delivery:write",
        "queue:consume",
        "ses:send",
        "metrics:write",
      ],
      siteKeyPrefixes: [prefix(input, "SUB#"), prefix(input, "EVENT#"), prefix(input, "DELIVERY#")],
      secretArns: [input.subscriptionSecretArns.unsubscribeSigningKey],
    },
    {
      role: "feedback",
      capabilities: ["subscriber:read", "subscriber:write", "feedback:write", "metrics:write"],
      siteKeyPrefixes: [prefix(input, "SUB#"), prefix(input, "FEEDBACK#")],
      secretArns: [],
    },
  );

  return roles;
}

export function validateIamRoleBoundaries(boundaries: IamRoleBoundary[]) {
  const roleIds = boundaries.map((boundary) => boundary.role);
  if (new Set(roleIds).size !== roleIds.length) return false;

  return boundaries.every((boundary) => {
    const capabilities = new Set(boundary.capabilities);
    return (
      capabilities.size === boundary.capabilities.length &&
      boundary.siteKeyPrefixes.length > 0 &&
      FORBIDDEN[boundary.role].every((capability) => !capabilities.has(capability))
    );
  });
}
