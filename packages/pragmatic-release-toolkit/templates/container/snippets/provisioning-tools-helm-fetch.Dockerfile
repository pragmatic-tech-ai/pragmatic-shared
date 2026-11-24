    case "$TARGETARCH" in amd64) H="$HELM_SHA256_AMD64" ;; arm64) H="$HELM_SHA256_ARM64" ;; esac; \
    curl -fsSL -o helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    echo "$H  helm.tgz" | sha256sum -c -; \
    tar -xzf helm.tgz "linux-${TARGETARCH}/helm" && mv "linux-${TARGETARCH}/helm" ./helm && rm -rf "linux-${TARGETARCH}" helm.tgz; \
