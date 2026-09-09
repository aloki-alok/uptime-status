import { createApp } from "./app";

const port = Number(Bun.env.PORT ?? 3000);

createApp().listen({ hostname: "0.0.0.0", port });

console.log(
  JSON.stringify({
    event: "server.started",
    port,
    service: "uptime-status-api",
  }),
);
