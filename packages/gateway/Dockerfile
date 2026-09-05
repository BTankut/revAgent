# syntax=docker/dockerfile:1

FROM node:24.14.1-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY installer/runtime-mcp-server/src ./installer/runtime-mcp-server/src
COPY installer/runtime-mcp-server/schemas ./installer/runtime-mcp-server/schemas

RUN npm ci --ignore-scripts \
    && npm run build --workspace @revagent/gateway

FROM build AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.14.1-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="revAgent Gateway"
LABEL org.opencontainers.image.description="revAgent Gateway production runtime"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build --chown=node:node /workspace/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build --chown=node:node /workspace/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /workspace/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=node:node /workspace/packages/gateway/registry-seed.json ./packages/gateway/registry-seed.json
COPY --from=build --chown=node:node /workspace/packages/gateway/node_modules ./packages/gateway/node_modules
COPY --from=build --chown=node:node /workspace/packages/gateway/dist ./packages/gateway/dist
COPY --from=build --chown=node:node /workspace/packages/gateway/migrations ./packages/gateway/migrations

USER node

RUN node --input-type=module --eval "await import('./packages/gateway/dist/index.js')"

# Proves entrypoint resolution, shipped migrations and fail-closed startup when
# production configuration is missing. Operational boot/read proof runs against
# this actual image with isolated Postgres in the EU-20 integration suite.
RUN node packages/gateway/dist/imageBootSmoke.js

CMD ["node", "packages/gateway/dist/main.js"]
