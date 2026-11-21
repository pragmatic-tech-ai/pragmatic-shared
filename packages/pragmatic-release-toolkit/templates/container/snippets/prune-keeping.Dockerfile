# Kept across the prune: {{Packages}}, dev dependencies the runtime imports (TODL loads esbuild and typescript at
# module load), stashed before it and restored after it.
RUN set -e; mkdir /runtime-dev-stash; \
    for pkg in {{Packages}}; do cp -a "node_modules/$pkg" "/runtime-dev-stash/$pkg"; done; \
    npm prune --omit=dev --no-audit --no-fund; \
    for pkg in {{Packages}}; do rm -rf "node_modules/$pkg"; cp -a "/runtime-dev-stash/$pkg" "node_modules/$pkg"; done; \
    rm -rf /runtime-dev-stash; \
    find . -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete
