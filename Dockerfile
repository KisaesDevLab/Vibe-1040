# syntax=docker/dockerfile:1
#
# The build needs `@kisaes/vibe-ai-client`, which is not on a public registry. CI clones the
# (public) Vibe-AI-Router repository into `vendor/sdk` before building; see
# .github/workflows/release.yml and scripts/install-deps.mjs. To build locally:
#
#   mkdir -p vendor && cp -r ../Vibe-AI-Router/packages/sdk vendor/sdk
#   NODE_AUTH_TOKEN=$(gh auth token) docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t vibe-1040 .
#
# `@kisaesdevlab/vibe-auth` (single sign-on, P16) comes from GitHub Packages, which requires a
# token with read:packages even to read. `.npmrc` maps the scope and holds no credential. The
# token arrives as a BuildKit secret, is written to a throwaway user npmrc, and is deleted in
# the same RUN — it is never an ARG or ENV, so it lands in no layer and no image history.
#
# **`package-lock.json` is copied on purpose.** Without it `npm install` resolves every caret
# range afresh inside the image, so the published artifact was never the dependency tree the
# tests ran against. That was latent from P0 and bit at v0.11.0: CI built `@kisaesdevlab/vibe-
# auth@1.0.4` from the lockfile and passed, the image floated to a newer 1.x that had added an
# audit event type, and `type satisfies AuditAction` in src/lib/vibeAuthUsers.ts failed the
# build — after CI was green, in the release. A released image must contain what was tested.

FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
COPY vendor ./vendor
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && node scripts/install-deps.mjs --omit=dev \
  ; status=$? ; rm -f /root/.npmrc ; exit $status

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
COPY vendor ./vendor
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && node scripts/install-deps.mjs \
  ; status=$? ; rm -f /root/.npmrc ; exit $status
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json && node scripts/copy-assets.mjs

FROM node:24-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/.npmrc ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && npm install --no-audit --no-fund \
  ; status=$? ; rm -f /root/.npmrc ; exit $status
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
