# The repository's .npmrc stays out of the context, so its `legacy-peer-deps` is repeated here (build stages only: the
# runtime stage does not inherit it).
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
