# The Agora MCP tools over Streamable HTTP (`agora-mcp http`, docs/mcp-http.md): the `mcp`
# service in docker-compose.prod.yml, reached through nginx at /mcp. Stdio installs don't use it.

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
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
USER node
EXPOSE 3100
CMD ["node", "dist/index.js", "http"]
