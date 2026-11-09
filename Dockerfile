# syntax=docker/dockerfile:1.7
# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY chain ./chain
COPY scripts/patch-idl.mjs scripts/bundle-vendor.mjs ./scripts/
# postinstall patches the IDL and bundles the browser vendor files (needs esbuild → keep dev deps here)
RUN npm ci

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3003 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    SOLANA_NETWORK=devnet

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/chain ./chain
COPY --from=build /app/public/vendor ./public/vendor
COPY package.json package-lock.json server.js cli.js ./
COPY lib ./lib
COPY routes ./routes
COPY proto ./proto
COPY public ./public

# Persistent state (.session-key, privy-wallets.json, nodes-cache.json) lives under DATA_DIR.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node
EXPOSE 3003
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
