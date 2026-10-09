# syntax=docker/dockerfile:1
# One Dockerfile, two images (PLAN.md decision 1):
#   docker build --target api .      HTTP API, also serves the built web app
#   docker build --target worker .   background jobs; M2 adds Chromium and ffmpeg here, M4 adds GDAL
# The server has no build step: Node runs the TypeScript sources directly (type stripping).

FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Manifests first, so dependency layers are cached until a package.json or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM manifests AS web
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@scan/web..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @scan/web build

FROM manifests AS prod-deps
# Production dependencies of the server and its workspace packages only. No `pnpm deploy`: Node will
# not strip types inside node_modules, so @scan/shared must stay a symlink to packages/shared.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@scan/server..."

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/server/package.json ./apps/server/
COPY apps/server/src ./apps/server/src
COPY apps/server/drizzle ./apps/server/drizzle
COPY --from=web /app/apps/web/dist ./apps/web/dist
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/src/main.ts", "api"]

FROM api AS worker
HEALTHCHECK NONE
CMD ["node", "apps/server/src/main.ts", "worker"]
