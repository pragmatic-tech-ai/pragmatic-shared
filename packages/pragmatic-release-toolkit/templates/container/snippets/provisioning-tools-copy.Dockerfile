COPY --from=provisioning-tools /tools/kubectl /usr/local/bin/kubectl
COPY --from=provisioning-tools /tools/kind /usr/local/bin/kind
COPY --from=provisioning-tools /tools/docker-cli /usr/local/bin/docker
