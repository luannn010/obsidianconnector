FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY services/queue-worker/strip-local-deps.mjs ./
RUN node strip-local-deps.mjs && npm ci
COPY src ./src
# Types are checked on the host (npm run typecheck); the image omits host-only
# optional packages such as the MCP metrics module, so emit without checking.
RUN npx tsc -p tsconfig.build.json --noCheck

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && git config --system --add safe.directory '*' \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/shared-worker.js"]
