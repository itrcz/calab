# Build context: repo root (see infra/docker/compose.yml).
FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
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
# License terms travel with the binary (BUSL-1.1: LICENSE, NOTICE with the attribution
# requirement, commercial terms) plus the licenses of bundled Go modules.
COPY LICENSE NOTICE COMMERCIAL-LICENSE.md /
COPY apps/server/THIRD-PARTY-NOTICES.txt /THIRD-PARTY-NOTICES.txt
# STORAGE_PATH=/data/files (ADR-0011). Owned by nonroot (65532) so a fresh named volume
# mounted here inherits writable ownership.
COPY --from=build --chown=65532:65532 /out/data /data
ENV STORAGE_DRIVER=fs STORAGE_PATH=/data/files
ENTRYPOINT ["/server"]
