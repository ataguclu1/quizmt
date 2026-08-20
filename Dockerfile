# syntax=docker/dockerfile:1

# ============================================================================
# AssisTT Quiz Time — portable production image
# Builds the React/quiz frontend and the API server, then runs a single Node
# process that serves BOTH the API and the static frontend on one port.
# Works on any host that runs containers: a VPS, Render, Railway, Fly.io, Koyeb…
# ============================================================================

# ---------- Stage 1: build ----------
FROM node:24-slim AS builder
WORKDIR /app

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable

# Install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

RUN pnpm install --no-frozen-lockfile

# Build only what production needs: the frontend and the API bundle.
ENV NODE_ENV=production
ENV BASE_PATH=/
RUN pnpm --filter @workspace/quiz run build \
 && pnpm --filter @workspace/api-server run build

# ---------- Stage 2: runtime ----------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

# Copy the whole built tree. The API server resolves the quiz files by relative
# path (../../quiz/dist/public), so the layout must be preserved.
COPY --from=builder /app /app

EXPOSE 8000
WORKDIR /app/artifacts/api-server
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
