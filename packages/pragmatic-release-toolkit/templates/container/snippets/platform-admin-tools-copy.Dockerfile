COPY --from=platform-admin-tools /tools/kubectl /usr/local/bin/kubectl
COPY --from=platform-admin-tools /tools/kind /usr/local/bin/kind
COPY --from=platform-admin-tools /tools/docker-cli /usr/local/bin/docker
