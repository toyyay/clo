# syntax=docker/dockerfile:1.7

FROM oven/bun:1-slim AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY index.html ./
COPY apps ./apps
COPY packages ./packages

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
RUN bun run build:frontend

FROM oven/bun:1-slim
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY server.ts index.html ./
COPY apps ./apps
COPY packages ./packages
COPY --from=builder /app/dist ./dist

ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
ENV PORT=3737
EXPOSE 3737

CMD ["bun", "apps/backend/server.ts"]
