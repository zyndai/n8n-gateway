# syntax=docker/dockerfile:1
# One Dockerfile, five targets (see docker-compose.yml):
#   build    - installs the workspace and compiles the Gateway bundle AND the n8n nodes package
#   migrate  - runs the Gateway's Drizzle migrations once, then exits
#   gateway  - the runtime image: just the compiled bundle
#   n8n      - official n8n with the compiled n8n-nodes-zynd package installed
#   studio   - Zynd Studio (apps/studio): the Next.js app, standalone output (its own build stage, so the
#              Gateway and n8n images never install Next.js)

ARG NODE_VERSION=22
ARG N8N_VERSION=2.47.0

# ---------------------------------------------------------------- build
# Full Debian image: n8n-workflow pulls in isolated-vm, a native module that needs python/make/g++ to compile.
FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /app
# Manifests first so the npm layer is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/n8n-nodes-zynd/package.json packages/n8n-nodes-zynd/
# Every workspace manifest must be present for the lock file to match; only the Gateway (root) and the n8n
# package are installed here. Zynd Studio installs in its own stage below.
COPY apps/studio/package.json apps/studio/
RUN npm ci --workspace=n8n-nodes-zynd --include-workspace-root
COPY . .
# Gateway -> dist/index.mjs (esbuild bundle); n8n package -> packages/n8n-nodes-zynd/dist (n8n-node build)
RUN npm run build && npm run build:nodes && npm run size -w n8n-nodes-zynd

# ---------------------------------------------------------------- migrate
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npm", "run", "db:migrate"]

# ---------------------------------------------------------------- gateway
FROM node:${NODE_VERSION}-alpine AS gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health >/dev/null || exit 1
# `npm start` carries the low-memory node flags (96 MB heap cap).
CMD ["npm", "start"]

# ---------------------------------------------------------------- n8n
FROM n8nio/n8n:${N8N_VERSION} AS n8n
# The package has no runtime dependencies, so package.json + dist is the whole install. It lives outside
# /home/node/.n8n so the data volume does not hide it. n8n loads nodes from N8N_CUSTOM_EXTENSIONS.
COPY --from=build --chown=node:node /app/packages/n8n-nodes-zynd/package.json /opt/n8n-custom/n8n-nodes-zynd/package.json
COPY --from=build --chown=node:node /app/packages/n8n-nodes-zynd/dist /opt/n8n-custom/n8n-nodes-zynd/dist
ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom

# ---------------------------------------------------------------- studio-build
# next build runs with no secrets: the Supabase address, the Gateway address and every key are read when the
# container starts, never baked into the image.
FROM node:${NODE_VERSION}-bookworm AS studio-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/n8n-nodes-zynd/package.json packages/n8n-nodes-zynd/
COPY apps/studio/package.json apps/studio/
RUN npm ci --workspace=zynd-studio
COPY apps/studio apps/studio
RUN npm run build -w zynd-studio

# ---------------------------------------------------------------- studio
FROM node:${NODE_VERSION}-alpine AS studio
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output holds server.js and the few node_modules it needs, laid out from the repo root
# (the app is an npm workspace); static files and public/ are not part of it and are copied beside it.
COPY --from=studio-build --chown=node:node /app/apps/studio/.next/standalone ./
COPY --from=studio-build --chown=node:node /app/apps/studio/.next/static ./apps/studio/.next/static
COPY --from=studio-build --chown=node:node /app/apps/studio/public ./apps/studio/public
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3100}/api/health >/dev/null || exit 1
CMD ["node", "apps/studio/server.js"]
