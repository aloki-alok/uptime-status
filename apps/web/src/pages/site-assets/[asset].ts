import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { APIRoute } from "astro";
import { site, siteAssetPath } from "../../lib/build-data";

export const prerender = true;

const assets = {
  [`logo-light${extname(site.brand.logoLightPath)}`]: site.brand.logoLightPath,
  [`logo-dark${extname(site.brand.logoDarkPath)}`]: site.brand.logoDarkPath,
  [`icon-light${extname(site.brand.iconLightPath)}`]: site.brand.iconLightPath,
  [`icon-dark${extname(site.brand.iconDarkPath)}`]: site.brand.iconDarkPath,
  [`favicon${extname(site.brand.faviconPath)}`]: site.brand.faviconPath,
};

const contentTypes: Record<string, string> = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function getStaticPaths() {
  return Object.entries(assets).map(([asset, path]) => ({ params: { asset }, props: { path } }));
}

export const GET: APIRoute = ({ props }) => {
  const path = siteAssetPath(props.path as string);
  const contentType = contentTypes[extname(path).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported site asset type: ${extname(path)}`);

  return new Response(readFileSync(path), {
    headers: {
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Content-Type": contentType,
    },
  });
};
