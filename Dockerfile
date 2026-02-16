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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=build /app/dist/ dist/

# Copy SQL migration files into the compiled output tree.
# tsc compiles with rootDir=. so dist/src/db/migrate.js uses __dirname to find
# dist/src/db/migrations/
COPY src/db/migrations/ dist/src/db/migrations/

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
