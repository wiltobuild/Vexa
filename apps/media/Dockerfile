FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable

# Copy the full workspace: pnpm workspaces resolve `workspace:*` deps and the
# monorepo lockfile needs to see every package.json to install correctly.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/media/package.json apps/media/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY apps/media apps/media
COPY apps/api apps/api
COPY packages/shared packages/shared

ENV NODE_ENV=development
EXPOSE 3003
CMD ["pnpm", "--filter", "@vexa/media", "start"]
