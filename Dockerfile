# syntax=docker/dockerfile:1
# One Dockerfile, four targets (see docker-compose.yml):
#   build    - installs the workspace and compiles the Gateway bundle AND the n8n nodes package
#   migrate  - runs the Gateway's Drizzle migrations once, then exits
#   gateway  - the runtime image: just the compiled bundle
#   n8n      - official n8n with the compiled n8n-nodes-zynd package installed

ARG NODE_VERSION=22
ARG N8N_VERSION=2.47.0

# ---------------------------------------------------------------- build
# Full Debian image: n8n-workflow pulls in isolated-vm, a native module that needs python/make/g++ to compile.
FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /app
# Manifests first so the npm layer is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/n8n-nodes-zynd/package.json packages/n8n-nodes-zynd/
RUN npm ci
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
