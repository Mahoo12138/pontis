# Pontis runs as one binary that already carries the Web app and the extension
# packages, so this file is a build pipeline that ends in an image with no
# toolchain left in it: the final stage holds the server binary, the TLS roots
# needed for outbound link checks, and a writable data directory — no Node, no
# pnpm, no WXT (distribution doc §12, §14.4).
#
#   docker build -t pontis:dev .
#   docker run -p 8080:8080 -v pontis-data:/data pontis:dev

# --- the compiled front end ---------------------------------------------------
# Web dist plus both extension packages, staged into the Go source tree because
# `go:embed` only sees files inside its own package.
#
# Pinned to the *build* platform on purpose. Without it a multi-platform build
# re-runs `pnpm install` and the whole front-end compile once per target
# architecture, which needs QEMU just to execute node, and an emulated
# Vite/WXT build costs minutes-per-step rather than seconds. The stage's output
# is a set of files — ZIPs and static assets carry no host architecture — so
# building it once on the machine we actually have is not a compromise.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS assets

WORKDIR /src
# Corepack would otherwise ask before downloading the pinned pnpm, and there is
# nobody to answer in a build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first: the install layer then survives every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .nvmrc ./
COPY web/package.json web/
COPY extension/package.json extension/
COPY packages/api/package.json packages/api/
COPY packages/i18n/package.json packages/i18n/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile

COPY scripts/ scripts/
COPY web/ web/
COPY extension/ extension/
COPY packages/ packages/
COPY server/ server/

# The release identity the distribution manifest records. A build has no .git
# here, so the caller says what it is building; empty is allowed and simply
# means "unstamped", which the download page renders as 未知 rather than lying.
ARG RELEASE=
ARG COMMIT=
ENV PONTIS_RELEASE=${RELEASE}
ENV PONTIS_RELEASE_COMMIT=${COMMIT}

RUN pnpm build:web \
 && pnpm build:extension:zip \
 && pnpm build:extension:zip:newtab \
 && node scripts/stage-web-dist.mjs \
 && node scripts/stage-distribution.mjs

# --- the server binary --------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build

# BuildKit gives every platform variant these two values; the Go toolchain then
# emits the target's binary while itself running on the build platform. This is
# the whole reason one image can be published for two architectures without a
# second machine.
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download

# The staged front end comes along with the source: the embed directives read
# internal/webui/dist and internal/distribution/artifacts at compile time.
COPY --from=assets /src/server ./

# CGO off is what makes this image buildable for more than one architecture:
# the SQLite driver is pure Go with the library compiled in as WASM.
ENV CGO_ENABLED=0
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w" -o /out/pontis ./cmd/server

# --- what ships ---------------------------------------------------------------
# A directory owned by the non-root user, so a named volume created from this
# image is writable on first run. A bind mount keeps the host's ownership
# instead, and the host side has to be made writable — see the README.
# Build platform again: `mkdir` and `chown` are commands to execute, and the
# files they produce are identical for every target.
FROM --platform=$BUILDPLATFORM alpine:3.20 AS staging
RUN mkdir -p /data && chown 65532:65532 /data && touch /data/.keep

FROM gcr.io/distroless/base-debian12:nonroot AS final

COPY --from=build /out/pontis /pontis
COPY --from=staging --chown=65532:65532 /data/.keep /data/.keep

ENV PONTIS_DATA_DIR=/data
ENV PONTIS_LISTEN=:8080
EXPOSE 8080
VOLUME ["/data"]

# Exec form: the image has no shell to hand a string to.
ENTRYPOINT ["/pontis"]
