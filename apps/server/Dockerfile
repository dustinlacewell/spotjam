# The spotjam relay. Build context is the repo root: the server imports
# @spotjam/protocol from the workspace, so the package must come along.
FROM node:22-alpine

RUN corepack enable

WORKDIR /repo

# Manifests first, so a source-only change does not re-resolve the store.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/

RUN pnpm install --frozen-lockfile --filter @spotjam/server...

COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server

WORKDIR /repo/apps/server

ENV HOST=0.0.0.0
ENV PORT=4444
# Written to the mounted volume, so identities outlive the container.
ENV SPOTJAM_DB=/data/spotjam.db
EXPOSE 4444

# TypeScript runs straight off the source; there is no build step. The import
# hook teaches Node to resolve the protocol package's .js specifiers to .ts.
CMD ["node", "--experimental-strip-types", "--import", "./src/register-hook.ts", "src/main.ts"]
