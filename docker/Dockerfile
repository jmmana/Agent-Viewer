FROM node:24-alpine AS base
WORKDIR /app

# Install dependencies based on package-lock.json
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source
COPY . .

# Build Vite frontend assets
RUN npm run build

# Default environment
ENV PORT=8787
ENV NODE_ENV=production
ENV AGENT_VIEWER_STORAGE=sqlite
ENV AGENT_VIEWER_SQLITE_PATH=/app/data/agent-viewer.db

EXPOSE 8787
EXPOSE 3000

# Start script running ingestion API and serving UI
CMD ["npm", "run", "dev:full"]
