import { snapshot } from "../lib/build-data";

export const prerender = true;

export function GET() {
  return new Response(JSON.stringify(snapshot), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
