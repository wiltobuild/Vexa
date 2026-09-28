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
WORKDIR /app/apps/media
# device-network-handling: run node directly (with tsx registered as an
# --import loader) instead of `pnpm --filter @vexa/media start`. Docker's
# default node:22-slim ENTRYPOINT execs CMD, so whatever CMD names becomes
# PID 1 and receives the container's SIGTERM directly. With `pnpm ... start`
# as CMD, pnpm itself was PID 1 -- live verification (sending a real SIGTERM
# to the running container) showed pnpm reporting "Command failed with
# signal SIGTERM" and the process never running its graceful-shutdown code
# at all: pnpm does not reliably forward the signal to let the wrapped
# script's own `process.on('SIGTERM')` handler run first. Invoking node
# directly here removes that layer, so the real process (and this file's
# graceful shutdown logic) is what actually receives the signal.
CMD ["node", "--env-file-if-exists=../../.env", "--import", "tsx/esm", "src/index.ts"]
