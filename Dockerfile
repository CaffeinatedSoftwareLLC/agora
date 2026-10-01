# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Turns on the startup checks in src/config.ts (refuse a missing or default key)
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=build /app/dist/ dist/

# Copy SQL migration files into the compiled output tree.
# tsc compiles with rootDir=. so dist/src/db/migrate.js uses __dirname to find
# dist/src/db/migrations/
COPY src/db/migrations/ dist/src/db/migrations/

# Run as the image's unprivileged `node` user (uid 1000). It owns the two places the
# services write to: the uploads directory (a volume created from the image inherits
# this ownership) and the setup-token directory.
RUN mkdir -p /data/files /app/.agora && chown node:node /data/files /app/.agora
USER node

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
