# syntax=docker/dockerfile:1
#
# drawer: one container running the server (API + built web app) with OpenSCAD for renders.
# Published as ghcr.io/spyrosbazios/drawer for amd64 and arm64 (.github/workflows/docker.yml).
#
#   render-base  OpenSCAD nightly (Manifold, EGL) + Bun + git + tini + the runtime user.
#                Enough to run @drawer/render and its tests; docker/openscad-dev uses it too.
#   web          builds web/dist
#   prod-deps    the server's production dependencies
#   app          (default) render-base + prod deps + server sources + web/dist
#
# `web` and `prod-deps` run on the builder's own architecture, never emulated: their output (static
# files, pure-JavaScript packages) is the same on every platform. A dependency with a native binary
# would have to be installed on the target platform instead.
#
# PNG export needs no X server: the nightly image builds OpenCSG >= 1.6, so OpenSCAD makes a
# headless EGL context (Mesa, software rendering). That is why there is no xvfb here.
#
# The build context is the repo root, cut down by .dockerignore to what these stages read.
#
# Build:  docker compose -f docker-compose.yml -f docker-compose.build.yml build

# Dated nightly tag, not :dev, so rebuilds are reproducible. Bump deliberately.
ARG OPENSCAD_IMAGE=openscad/openscad:dev.2026-11-16
# Same Bun as the lockfile was written with.
ARG BUN_VERSION=1.3.9

# The target platform's Bun: render-base copies its binary.
FROM oven/bun:${BUN_VERSION}-slim AS bun

# Only the manifests, so dependency layers are reused until a package.json or bun.lock changes.
FROM scratch AS manifests
COPY package.json bun.lock /
COPY shared/package.json /shared/
COPY server/package.json /server/
COPY render/package.json /render/
COPY importers/package.json /importers/
COPY cli/package.json /cli/
COPY agent/package.json /agent/
COPY web/package.json /web/
COPY site/package.json /site/

FROM ${OPENSCAD_IMAGE} AS render-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# BOSL2 beside the bundled MCAD, on OpenSCAD's built-in library path, so `include <BOSL2/std.scad>`
# works in every project. Pinned to a commit; bump deliberately.
ARG BOSL2_COMMIT=1351a9f7e5f30a95228e580d167fd4f2e184ad2c
RUN git init -q /usr/local/share/openscad/libraries/BOSL2 \
 && cd /usr/local/share/openscad/libraries/BOSL2 \
 && git fetch -q --depth 1 https://github.com/BelfrySCAD/BOSL2.git "${BOSL2_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && rm -rf .git examples tests tutorials images
# The default user. Compose runs the container as the owner of the data folder instead when that is not 1000
# (DRAWER_UID, DRAWER_GID), so nothing here may depend on who runs it.
# -o: the id may already exist in the base image under another name.
RUN groupadd -o -g 1000 drawer \
 && useradd -o -u 1000 -g 1000 -M -d /tmp -s /usr/sbin/nologin drawer
# OpenSCAD writes its settings under $HOME/.config and Mesa its shader cache under $HOME/.cache, and OpenSCAD
# does not start without them: a home any user can write to.
ENV HOME=/tmp
WORKDIR /app
USER drawer

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS web
WORKDIR /app
COPY --from=manifests / ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd web build

# The server's runtime dependencies only: web ships as prebuilt static files, and the agent runner
# and the public site are not in the image.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS prod-deps
WORKDIR /app
COPY --from=manifests / ./
RUN bun install --frozen-lockfile --production --filter '!@drawer/web' --filter '!@drawer/agent' --filter '!@drawer/site'

FROM render-base AS app
USER root
# App files stay root-owned (read-only for the server); only /data is the server's.
COPY --from=prod-deps /app /app
COPY shared /app/shared
COPY render /app/render
COPY importers /app/importers
COPY server /app/server
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /data && chown drawer:drawer /data
# The release this image is (scripts/version.sh); GET /api/health reports it.
ARG DRAWER_VERSION=0.0.0
# 0.0.0.0 inside the container only: the port is published by Compose, on loopback unless told otherwise.
ENV NODE_ENV=production \
    DRAWER_DATA=/data \
    DRAWER_HOST=0.0.0.0 \
    PORT=3050 \
    DRAWER_WEB_DIST=/app/web/dist \
    DRAWER_VERSION=${DRAWER_VERSION}
USER drawer
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:3050/api/health'); process.exit(r.ok ? 0 : 1)"]
# tini reaps orphans: a render timeout kills OpenSCAD's whole process group.
ENTRYPOINT ["tini", "--"]
CMD ["bun", "server/src/main.ts"]
