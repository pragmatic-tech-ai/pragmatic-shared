# The provisioning CLIs the admin drives remote targets with (spec D26): kubectl, kind and the docker CLI (client only;
# no daemon runs in or next to admin). Each download is checked against a pinned sha256 for the build's TARGETARCH.
# Upstream checksums: dl.k8s.io/release/<v>/bin/linux/<arch>/kubectl.sha256 and the kind release's
# kind-linux-<arch>.sha256sum. download.docker.com publishes no checksums for the static bundles, so those two are pinned
# from a verified download (2026-11-19).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS platform-admin-tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
ARG KIND_VERSION=v0.33.0
ARG KIND_SHA256_AMD64=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
ARG KIND_SHA256_ARM64=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2
ARG DOCKER_VERSION=29.10.0
ARG DOCKER_SHA256_AMD64=7c1ebadc65c716cdc6d35fc78759ed0e4317debf43c21dd12f066f2006999def
ARG DOCKER_SHA256_ARM64=6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) K="$KUBECTL_SHA256_AMD64"; I="$KIND_SHA256_AMD64"; D="$DOCKER_SHA256_AMD64"; DA=x86_64 ;; \
      arm64) K="$KUBECTL_SHA256_ARM64"; I="$KIND_SHA256_ARM64"; D="$DOCKER_SHA256_ARM64"; DA=aarch64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tools && cd /tools; \
    curl -fsSL -o kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "$K  kubectl" | sha256sum -c -; \
    curl -fsSL -o kind "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${TARGETARCH}"; \
    echo "$I  kind" | sha256sum -c -; \
    curl -fsSL -o docker.tgz "https://download.docker.com/linux/static/stable/${DA}/docker-${DOCKER_VERSION}.tgz"; \
    echo "$D  docker.tgz" | sha256sum -c -; \
    tar -xzf docker.tgz docker/docker && mv docker/docker ./docker-cli && rm -rf docker docker.tgz; \
    chmod 0755 kubectl kind docker-cli
