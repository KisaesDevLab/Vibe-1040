# syntax=docker/dockerfile:1
#
# The build needs `@kisaes/vibe-ai-client`, which is not on a public registry. CI clones the
# (public) Vibe-AI-Router repository into `vendor/sdk` before building; see
# .github/workflows/release.yml and scripts/install-deps.mjs. To build locally:
#
#   mkdir -p vendor && cp -r ../Vibe-AI-Router/packages/sdk vendor/sdk
#   docker build -t vibe-1040 .

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache git
COPY package.json ./
COPY scripts ./scripts
COPY vendor ./vendor
RUN node scripts/install-deps.mjs --omit=dev

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY vendor ./vendor
RUN node scripts/install-deps.mjs
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8240/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
