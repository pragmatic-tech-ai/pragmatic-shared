RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd {{Dir}} && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules
