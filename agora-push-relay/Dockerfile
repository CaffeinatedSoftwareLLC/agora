# Agora push relay. Build from this directory: docker build -t agora-push-relay agora-push-relay
# Node is pinned to an exact release in both stages: node:sqlite is still flagged
# experimental on Node 22, so a minor upgrade is a deliberate change, tested first.
# ---- Build stage ----
FROM node:22.23.4-alpine3.24 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ---- Runtime stage ----
FROM node:22.23.4-alpine3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/ dist/

# Run as the image's unprivileged `node` user (uid 1000). /data holds the SQLite file;
# a named volume created from the image inherits this ownership.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node:sqlite is stable in behaviour but still flagged experimental on Node 22.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
