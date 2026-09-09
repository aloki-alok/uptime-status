import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { site } from "./lib/build-data";

const webRoot = resolve(import.meta.dir, "..");
const build = Bun.spawn(["bunx", "astro", "build"], {
  cwd: webRoot,
  env: process.env,
  stderr: "inherit",
  stdout: "inherit",
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);

if (site.deploymentMode === "production") {
  const previewOutput = resolve(webRoot, "dist/v");
  if (previewOutput !== resolve(webRoot, "dist", "v")) {
    throw new Error("Refusing to remove an unexpected preview output path");
  }
  rmSync(previewOutput, { recursive: true, force: true });
}
