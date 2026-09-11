import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createReadPathApp } from "./read-path-stack";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

const publisherAssetPath = process.env.STATUS_PUBLISHER_ASSET_PATH;
const siteConfigPath = resolve(required("STATUS_SITE_CONFIG_PATH"));
let site: unknown;
try {
  site = JSON.parse(readFileSync(siteConfigPath, "utf8"));
} catch {
  throw new TypeError("STATUS_SITE_CONFIG_PATH must contain valid JSON");
}
const app = createReadPathApp({
  deploymentInputs: {
    schemaVersion: "1.0.0",
    siteId: required("STATUS_SITE_ID"),
    environment: "preview",
    aws: {
      accountId: required("STATUS_AWS_ACCOUNT_ID"),
      region: required("STATUS_AWS_REGION"),
    },
    monitoringSecretArn: required("STATUS_MONITORING_SECRET_ARN"),
  },
  publicAssetPath: resolve(required("STATUS_PUBLIC_ASSET_PATH")),
  ...(publisherAssetPath ? { publisherAssetPath: resolve(publisherAssetPath) } : {}),
  publisher: {
    site: site as never,
    sourceId: required("STATUS_SOURCE_ID"),
  },
});

app.synth();
