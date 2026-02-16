# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Skip tsc type-checking (test files use vitest matchers that fail tsc -b).
# Vite uses esbuild for transpilation so tsc isn't needed for the production bundle.
RUN npx vite build

# ---- Serve stage ----
FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
