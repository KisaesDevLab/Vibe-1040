# The OpenTax engine, as a sidecar (P17, CLAUDE.md §14).
#
# Debian rather than Alpine on purpose: the engine is a `deno compile` binary linked against
# glibc, and the app's own runtime image (`node:24-alpine`) is musl. That mismatch is the main
# reason this is a separate service rather than another binary in the API image — which suits
# the design anyway, since the process boundary is what keeps the AGPL integration severable
# (QUESTIONS.md Q22).
#
# The version is pinned and the download is verified by SHA-256. That is not ceremony: this is
# a young, largely AI-maintained tax engine, and a harness score means nothing if the binary
# underneath it can move. `install.sh | sh` into a floating latest is not acceptable here.
#
#   docker build -t vibe-1040-opentax \
#     --build-arg OPENTAX_VERSION=v0.1.0 \
#     --build-arg OPENTAX_SHA256=<sha256 of opentax-linux-x64> \
#     opentax/
#
# To find the checksum for a release, download the asset once and `sha256sum` it, then record
# the pair in docs/opentax-draft-return.md so the next operator does not have to trust a fresh
# download to tell them what a good download looks like.
FROM node:24-bookworm-slim AS engine

ARG OPENTAX_VERSION
ARG OPENTAX_SHA256
ARG OPENTAX_ASSET=opentax-linux-x64

RUN test -n "$OPENTAX_VERSION" || (echo "OPENTAX_VERSION build-arg is required" >&2; exit 1) \
 && test -n "$OPENTAX_SHA256"  || (echo "OPENTAX_SHA256 build-arg is required — do not build unpinned" >&2; exit 1)

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/opentax \
      "https://github.com/filedcom/opentax/releases/download/${OPENTAX_VERSION}/${OPENTAX_ASSET}" \
 && echo "${OPENTAX_SHA256}  /tmp/opentax" | sha256sum -c - \
 && install -m 0755 /tmp/opentax /usr/local/bin/opentax \
 && rm -f /tmp/opentax \
 && /usr/local/bin/opentax version

# ---

FROM node:24-bookworm-slim AS runtime

# The engine is AGPL v3. It is conveyed here unmodified and invoked as a subprocess; its
# licence travels with it so anyone handed this image is told where the source is.
COPY --from=engine /usr/local/bin/opentax /usr/local/bin/opentax
ADD https://raw.githubusercontent.com/filedcom/opentax/main/LICENSE /usr/share/licenses/opentax/LICENSE

WORKDIR /app
COPY server.mjs ./server.mjs

RUN useradd --system --create-home --shell /usr/sbin/nologin opentax
USER opentax

ENV PORT=8230 \
    OPENTAX_BIN=/usr/local/bin/opentax \
    NODE_ENV=production

EXPOSE 8230

# No secrets, no volumes, no database. Each request computes in its own temp directory and
# deletes it, so nothing holding taxpayer amounts survives the response.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
