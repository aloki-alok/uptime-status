import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "apps/web/dist");
const exampleConfig = resolve(root, "examples/status.config.json");
const secondConfig = resolve(root, "examples/second-site.config.json");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".svg"]);

function filesBelow(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry);
      return statSync(path).isDirectory() ? filesBelow(path) : [path];
    })
    .sort();
}

function manifest() {
  return filesBelow(dist).map((path) => relative(dist, path));
}

function searchableOutput() {
  return filesBelow(dist)
    .filter((path) => textExtensions.has(path.slice(path.lastIndexOf("."))))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .toLowerCase();
}

function assetHash(name: string) {
  return createHash("sha256")
    .update(readFileSync(resolve(dist, "site-assets", name)))
    .digest("hex");
}

async function build(config: string) {
  const child = Bun.spawn(["bun", "run", "build"], {
    cwd: root,
    env: { ...process.env, STATUS_SITE_CONFIG: config, STATUS_SNAPSHOT_PATH: "" },
    stderr: "inherit",
    stdout: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Site build failed with exit code ${exitCode}`);
}

function requireMarker(output: string, marker: string) {
  if (!output.includes(marker)) throw new Error(`Expected site marker is missing: ${marker}`);
}

function rejectMarkers(output: string, markers: string[]) {
  const leaked = markers.find((marker) => output.includes(marker));
  if (leaked) throw new Error(`Cross-site marker leaked into build output: ${leaked}`);
}

await build(exampleConfig);
const exampleOutput = searchableOutput();
const exampleManifest = manifest();
const exampleLogoHash = assetHash("logo-light.svg");
requireMarker(exampleOutput, "example service");
requireMarker(exampleOutput, "public-api");
rejectMarkers(exampleOutput, ["northwind cloud", "edge-gateway", "europe/london"]);

await build(secondConfig);
const secondOutput = searchableOutput();
const secondManifest = manifest();
const secondLogoHash = assetHash("logo-light.svg");
requireMarker(secondOutput, "northwind cloud");
requireMarker(secondOutput, "edge-gateway");
rejectMarkers(secondOutput, ["example service", "public-api", "status.example.com"]);

if (JSON.stringify(exampleManifest) !== JSON.stringify(secondManifest)) {
  throw new Error("Site build manifests differ, so stale output cannot be ruled out");
}
if (exampleLogoHash === secondLogoHash) {
  throw new Error("Site logo assets were not isolated");
}

await build(exampleConfig);
console.log("Site isolation verified across two independent builds");
