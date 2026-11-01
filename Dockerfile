# syntax=docker/dockerfile:1
# One image, three commands: `web`, `worker`, `migrate` (see docker/entrypoint.sh).
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.28.0 && npm cache clean --force
WORKDIR /repo

# Dependency layer: only manifests + lockfile, so source edits do not bust the install cache.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/services/package.json packages/services/
COPY packages/mcp/package.json packages/mcp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM deps AS build
COPY . .
# Commit SHA: Next build id and revision of the precached /offline page (see next.config.ts).
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN pnpm -r --if-present build
# Production-only trees for the worker (also carries @arfolio/db with dist + migrations for `migrate`).
RUN pnpm --filter @arfolio/worker --prod deploy /out/worker \
    && rm -f /out/worker/dist/*.map

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=0:0 /repo/apps/web/.next/standalone /app/web
COPY --from=build --chown=0:0 /repo/apps/web/.next/static /app/web/apps/web/.next/static
COPY --from=build --chown=0:0 /repo/apps/web/public /app/web/apps/web/public
COPY --from=build --chown=0:0 /out/worker /app/worker
COPY --chown=0:0 docker/entrypoint.sh /app/entrypoint.sh
# Read-only root FS: Next's image/fetch cache lives under .next/cache, so point it at /tmp.
RUN rm -rf /app/web/apps/web/.next/cache \
    && ln -s /tmp/next-cache /app/web/apps/web/.next/cache \
    && chmod 0555 /app/entrypoint.sh
USER 1001:1001
EXPOSE 3000 8081
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["web"]
