import { defineConfig } from "astro/config";

export default defineConfig({
  build: {
    assets: "assets",
  },
  compressHTML: true,
  output: "static",
  trailingSlash: "always",
});
