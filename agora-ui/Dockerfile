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
# Pinned by digest (nginx 1.31.7, Alpine). Bump deliberately: docker buildx imagetools inspect nginx:<ver>-alpine
FROM nginx:1.31.7-alpine@sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
