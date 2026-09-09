import { semanticForeground } from "@uptime-status/domain";
import type { APIRoute } from "astro";
import { site } from "../lib/build-data";

export const prerender = true;

export const GET: APIRoute = () => {
  const colors = site.presentation.semanticColors;
  const css = `:root {
  --green: ${colors.operational};
  --blue: ${colors.maintenance};
  --amber: ${colors.degraded};
  --red: ${colors.outage};
  --muted-status: ${colors.unknown};
  --on-green: ${semanticForeground(colors.operational)};
  --on-blue: ${semanticForeground(colors.maintenance)};
  --on-amber: ${semanticForeground(colors.degraded)};
  --on-red: ${semanticForeground(colors.outage)};
  --on-muted-status: ${semanticForeground(colors.unknown)};
}`;

  return new Response(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
    },
  });
};
