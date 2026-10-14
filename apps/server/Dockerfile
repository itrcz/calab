# Build context: repo root (see infra/docker/compose.yml).
FROM golang:1.26.9-alpine@sha256:cdfd4fe2da6b225d8b40c6b7a105736e548e83ff56d5d8f9394446eeb5eb84e0 AS build
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum* ./
RUN go mod download
COPY apps/server/ ./
# Build stamp (GET /api/version); compose passes CALABA_VERSION / CALABA_COMMIT.
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 go build -trimpath -tags nodynamic \
      -ldflags="-s -w -X github.com/calaba/calaba/server/internal/buildinfo.Version=${VERSION} -X github.com/calaba/calaba/server/internal/buildinfo.Commit=${COMMIT}" \
      -o /out/server ./cmd/server \
 && mkdir -p /out/data/files

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/server /server
# ffmpeg + ffprobe 8.0 (static, no shared libs — fits distroless) for HEIC → JPEG
# (POST /api/files/convert, docs/02 «Изображения») and later the soundboard (ADR-0036).
# A separate executable run as a subprocess (FFMPEG_PATH / FFPROBE_PATH); this build is GPL.
COPY --from=mwader/static-ffmpeg:8.0@sha256:415a41fa3167b890b9703d20bd0f00bf1e9dab8a4b6c27fef1445b2bf5f1ab4a /ffmpeg /ffprobe /usr/local/bin/
# License terms travel with the binary (BUSL-1.1: LICENSE, NOTICE with the attribution
# requirement, commercial terms) plus the licenses of bundled Go modules.
COPY LICENSE NOTICE COMMERCIAL-LICENSE.md /
COPY apps/server/THIRD-PARTY-NOTICES.txt /THIRD-PARTY-NOTICES.txt
# STORAGE_PATH=/data/files (ADR-0011). Owned by nonroot (65532) so a fresh named volume
# mounted here inherits writable ownership.
COPY --from=build --chown=65532:65532 /out/data /data
ENV STORAGE_DRIVER=fs STORAGE_PATH=/data/files
ENTRYPOINT ["/server"]
