import { resolve } from "node:path";
import { createReadPathApp } from "./read-path-stack";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

const publisherAssetPath = process.env.STATUS_PUBLISHER_ASSET_PATH;
const app = createReadPathApp({
  deploymentInputs: {
    schemaVersion: "1.0.0",
    siteId: required("STATUS_SITE_ID"),
    environment: "preview",
    aws: {
      accountId: required("STATUS_AWS_ACCOUNT_ID"),
      region: required("STATUS_AWS_REGION"),
    },
  },
  publicAssetPath: resolve(required("STATUS_PUBLIC_ASSET_PATH")),
  ...(publisherAssetPath ? { publisherAssetPath: resolve(publisherAssetPath) } : {}),
  publisher: {
    targetUrl: required("STATUS_TARGET_URL"),
    slug: required("STATUS_COMPONENT_SLUG"),
    name: required("STATUS_COMPONENT_NAME"),
    group: required("STATUS_COMPONENT_GROUP"),
  },
});

app.synth();
