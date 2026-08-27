# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN corepack enable && npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.build.json && node scripts/copy-assets.mjs

FROM node:24-alpine AS ui
WORKDIR /ui
COPY ui/package.json ./
RUN npm install --no-audit --no-fund
COPY ui ./
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=ui    /ui/dist ./ui/dist
COPY package.json ./
COPY data ./data
RUN mkdir -p /data/blobs && chown -R app:app /data/blobs
USER app
EXPOSE 8240
CMD ["node", "dist/server.js"]
