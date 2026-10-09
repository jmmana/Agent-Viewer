# syntax=docker/dockerfile:1
#
# Agent Viewer images. Build from the repository root (docker/Dockerfile.dockerignore applies):
#
#   docker build -f docker/Dockerfile -t agent-viewer .                  # office + API in one container
#   docker build -f docker/Dockerfile --target api -t agent-viewer-api .
#   docker build -f docker/Dockerfile --target viewer \
#     --build-arg VITE_AGENT_VIEWER_API_URL=http://localhost:8787 -t agent-viewer-viewer .
#
# Without --target the last stage (app) is built: the `agent-viewer` CLI serving the office and the API on
# port 8787. It is the image published as ghcr.io/jmmana/agent-viewer. docker/compose.yml runs api and viewer
# as two services instead.

# Shared dependency layer. The ingestion server runs TypeScript through tsx and uses express, which are
# devDependencies, so the full dependency tree is installed.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Static build of the office. Vite inlines VITE_* variables when it bundles, so the API URL must be known
# here: it is the address the browser uses to reach the API, not an address inside the Docker network.
FROM deps AS viewer-build
ARG VITE_AGENT_VIEWER_API_URL=http://localhost:8787
ARG VITE_AGENT_VIEWER_MODE=live
ENV VITE_AGENT_VIEWER_API_URL=${VITE_AGENT_VIEWER_API_URL} \
    VITE_AGENT_VIEWER_MODE=${VITE_AGENT_VIEWER_MODE}
COPY . .
RUN npm run build

# Office: the built files served by a small Node static server, with no node_modules.
FROM node:24-alpine AS viewer
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_ROOT=/app/dist
COPY --from=viewer-build /app/dist ./dist
COPY docker/static-server.mjs ./static-server.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "static-server.mjs"]

# Ingestion API (published as ghcr.io/jmmana/agent-viewer:<version>-api), with SQLite persistence in /app/data.
# It listens on every interface, so it never runs without a token: AGENT_VIEWER_API_TOKEN when set, else a
# token generated on first start, saved in /app/data/api-token and printed in the logs
# (docker/api-entrypoint.mjs).
FROM deps AS api
ENV NODE_ENV=production \
    PORT=8787 \
    AGENT_VIEWER_STORAGE=sqlite \
    AGENT_VIEWER_SQLITE_PATH=/app/data/agent-viewer.db \
    AGENT_VIEWER_TOKEN_FILE=/app/data/api-token
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "/app/docker/api-entrypoint.mjs"]

# Build of the `agent-viewer` CLI: the server bundled for Node plus the office prebuilt for same-origin use.
FROM deps AS cli-build
COPY . .
RUN npm run build:cli

# Office and API in one container (default target): `docker run -p 8787:8787 ghcr.io/jmmana/agent-viewer`.
# Only the runtime dependencies are installed. The token is printed on start; set AGENT_VIEWER_API_TOKEN to
# choose it. Inside the container the server has to listen on every interface for the published port to work,
# so AGENT_VIEWER_HOST is 0.0.0.0. docker/app-entrypoint.sh adds the flags given to `docker run IMAGE ...` to
# these defaults instead of replacing them; change the port with `-e PORT=...` (or `--port`, which the health
# check follows too).
FROM node:24-alpine AS app
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    AGENT_VIEWER_HOST=0.0.0.0 \
    AGENT_VIEWER_HOME=/app/data \
    AGENT_VIEWER_STORAGE=sqlite \
    AGENT_VIEWER_SQLITE_PATH=/app/data/agent-viewer.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts && npm cache clean --force
COPY --from=cli-build /app/dist-cli ./dist-cli
COPY docker/app-entrypoint.sh docker/healthcheck.mjs ./docker/
RUN chmod 0755 docker/app-entrypoint.sh && mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node /app/docker/healthcheck.mjs || exit 1
ENTRYPOINT ["/app/docker/app-entrypoint.sh"]
