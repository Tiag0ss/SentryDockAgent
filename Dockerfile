# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* .npmrc* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install

FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# docker CLI needed for `docker login` fallback on private registry pulls (socket is mounted).
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Non-root is impractical when mounting /var/run/docker.sock; run as root by design (Portainer-agent pattern).
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/protocol ./protocol
CMD ["node", "dist/src/index.js"]
