RUN npm prune --omit=dev --no-audit --no-fund \
    && find . -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete
