import type { APIRoute } from "astro";
import { site } from "../../lib/build-data";

export const prerender = true;

export const GET: APIRoute = () =>
  Response.json(site, {
    headers: {
      "cache-control": "no-store",
    },
  });
