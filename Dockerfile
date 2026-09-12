# syntax=docker/dockerfile:1
# Runs the native monitor (apps/monitor): probes, stores, rolls up, and publishes a
# snapshot outward. It does not serve the public page.

# Deps stage needs the whole workspace: `bun install --frozen-lockfile` resolves every
# package.json bun.lock references, even though the runtime only uses a subset of them.
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# Runtime stage: only the monitor app and the workspace packages it actually imports.
FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

RUN groupadd --system monitor && useradd --system --gid monitor --home-dir /app --no-create-home monitor

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/monitor apps/monitor
COPY packages/monitor packages/monitor
COPY packages/uptime-math packages/uptime-math
COPY packages/status-contract packages/status-contract
COPY packages/snapshot packages/snapshot

# STATUS_DATABASE must point inside this volume so history survives the container
# being replaced (redeploy, crash-restart, image update).
RUN mkdir -p /data && chown -R monitor:monitor /app /data
VOLUME ["/data"]

USER monitor
CMD ["bun", "apps/monitor/src/index.ts"]
