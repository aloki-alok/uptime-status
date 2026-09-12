# syntax=docker/dockerfile:1
# Runs the native monitor (apps/monitor): probes, stores, rolls up, and publishes a
# snapshot outward. It does not serve the public page.
#
# The runtime ships a single compiled binary and no node_modules. That is not premature
# tuning: a workspace install drags in aws-cdk-lib, workerd, miniflare and biome for sibling
# packages the monitor never imports, which put the image at 1.07GB on the host. The box this
# is built for has an 8GB root volume shared with Uptime Kuma, Grafana and Loki, so image size
# is a production risk rather than a nicety.

FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# musl target so the binary runs on Alpine. bun:sqlite is built into the runtime and is
# bundled by --compile, so the image needs no SQLite package of its own.
RUN bun build --compile --target=bun-linux-x64-musl apps/monitor/src/index.ts --outfile /monitor

FROM alpine:3.22 AS runtime
WORKDIR /app
# The musl-compiled binary links against libstdc++, which bare Alpine does not ship.
RUN apk add --no-cache libstdc++ && addgroup -S monitor && adduser -S -G monitor -h /app -H monitor
COPY --from=build /monitor /usr/local/bin/monitor
RUN printf '#!/bin/sh\nexec /usr/local/bin/monitor --operator "$@"\n' > /usr/local/bin/status && chmod 755 /usr/local/bin/status

# STATUS_DATABASE must point inside this volume so history survives the container being
# replaced. Losing it means losing every day since the migration cutoff.
RUN mkdir -p /data && chown -R monitor:monitor /app /data
VOLUME ["/data"]

USER monitor
ENTRYPOINT ["/usr/local/bin/monitor"]
