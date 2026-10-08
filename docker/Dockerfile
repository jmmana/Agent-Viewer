# syntax=docker/dockerfile:1
#
# Agent Viewer images. Build from the repository root (docker/Dockerfile.dockerignore applies):
#
#   docker build -f docker/Dockerfile --target api -t agent-viewer-api .
#   docker build -f docker/Dockerfile --target viewer \
#     --build-arg VITE_AGENT_VIEWER_API_URL=http://localhost:8787 -t agent-viewer-viewer .
#
# Without --target the last stage (api) is built. docker/compose.yml builds and runs both.

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

# Ingestion API (default target): npm run server, with SQLite persistence in /app/data.
FROM deps AS api
ENV NODE_ENV=production \
    PORT=8787 \
    AGENT_VIEWER_STORAGE=sqlite \
    AGENT_VIEWER_SQLITE_PATH=/app/data/agent-viewer.db
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["npm", "run", "server"]
