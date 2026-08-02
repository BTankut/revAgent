# syntax=docker/dockerfile:1

FROM node:24.14.1-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY installer/runtime-mcp-server/src ./installer/runtime-mcp-server/src
COPY installer/runtime-mcp-server/schemas ./installer/runtime-mcp-server/schemas

RUN npm ci --ignore-scripts \
    && npm run build --workspace @revagent/gateway \
    && npm prune --omit=dev --ignore-scripts

FROM node:24.14.1-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="revAgent Gateway"
LABEL org.opencontainers.image.description="revAgent Gateway M2 build artifact"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=node:node /workspace/packages/gateway/node_modules ./packages/gateway/node_modules
COPY --from=build --chown=node:node /workspace/packages/gateway/dist ./packages/gateway/dist

USER node

RUN node --input-type=module --eval "await import('./packages/gateway/dist/index.js')"

# Proves the image actually boots and reports healthy, inside the build that CI
# already runs. The Gateway CI workflow builds this image but never runs it, and
# that workflow is out of scope here -- putting the proof in the build turns
# "the container boots; health is green" into a red CI gate with no workflow
# change at all. It covers what a barrel import cannot: the entry point path
# resolves, ESM resolution works from dist/ where the workspace root manifest is
# absent, the production non-loopback bind rule does not block boot, and SIGTERM
# drains cleanly.
RUN node packages/gateway/dist/imageBootSmoke.js

CMD ["node", "packages/gateway/dist/main.js"]
