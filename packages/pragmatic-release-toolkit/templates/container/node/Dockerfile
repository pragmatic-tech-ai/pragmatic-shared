# syntax=docker/dockerfile:1
# {{App}}: one image, built from this repository alone; every @pragmatic-tech-ai package comes from GitHub Packages
# through the lock (no sibling checkout). Rendered by pragmatic-container-template (@pragmatic-tech-ai/pragmatic-release-toolkit).
# The image carries its component descriptor at /pragmatic/component.json and the descriptor's digest as the label
# ai.pragmatic-tech.component.digest. Build in two steps (docker-bake.hcl): `components` exports the descriptor, its
# digest and the bake override that hands the image target its COMPONENT_APP and COMPONENT_DIGEST, then the image:
#   NPMRC_FILE=$HOME/.npmrc docker buildx bake -f docker-bake.hcl --allow=fs.read=$HOME/.npmrc components
#   NPMRC_FILE=$HOME/.npmrc VERSION=0.1.0 GIT_SHA=$(git rev-parse HEAD) docker buildx bake -f docker-bake.hcl \
#     -f .components/docker-bake.components.json --allow=fs.read=$HOME/.npmrc {{App}}
# NPMRC_FILE names an .npmrc able to read @pragmatic-tech-ai packages; it reaches the build only as the BuildKit secret
# `npmrc`, never as an ARG, an ENV or a layer (.dockerignore keeps the repository's own .npmrc out of the context).
# The image paths sit under /workspace/{{App}}, the layout pragmatic-closure-check reads this file with.

FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS deps
WORKDIR /workspace/{{App}}
# Native addons (lmdb, where an app reaches it) need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# The manifests and the lock first, so the install layer is reused while they do not change.
COPY package.json package-lock.json ./
{{WorkspaceManifests}}
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    npm ci --no-audit --no-fund

FROM deps AS compile
COPY . .
RUN npm run build
{{Assets}}
{{UiBuilds}}
{{ClosureCheckStep}}

# The component descriptor, from the repository's descriptor class: {{ComponentsModule}} exports `Components`, an
# IReleaseComponentSource of this one app (ContainerComponentSource). `component-set` writes it with its digest and the
# bake override; the `components` bake target exports them before the image is baked, since a label value must be known
# when the build starts.
FROM compile AS component-set
RUN ./node_modules/.bin/pragmatic-component-descriptors --components {{ComponentsModule}} emit-all --out /components

FROM scratch AS components
COPY --from=component-set /components /

# The descriptor the image carries: the CLI refuses one whose digest is not COMPONENT_DIGEST (the label value), and the
# bytes written are hashed once more, so /pragmatic/component.json and the label always agree. A build without the
# override stops here.
FROM compile AS component
ARG COMPONENT_APP
ARG COMPONENT_DIGEST
RUN [ "$COMPONENT_APP" = "{{App}}" ] \
    || { echo "COMPONENT_APP is not {{App}}: bake with the .components/docker-bake.components.json override" >&2; exit 1; }
RUN ./node_modules/.bin/pragmatic-component-descriptors --components {{ComponentsModule}} emit --app "{{App}}" --digest "$COMPONENT_DIGEST" --out /component/component.json
RUN [ "sha256:$(sha256sum /component/component.json | cut -d ' ' -f 1)" = "$COMPONENT_DIGEST" ] \
    || { echo "component descriptor digest mismatch: bake with the .components/docker-bake.components.json override" >&2; exit 1; }

# Production dependencies only; source maps and build info dropped.
FROM compile AS build
{{Prune}}
{{ModuleDirs}}

{{ToolsStage}}

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production
# The service runs as 10001 (uid and gid); the app tree is root's and read-only to it, but for the directories the render
# option WritableDirs names.
RUN groupadd --system --gid 10001 pragmatic && useradd --system --create-home --uid 10001 --gid 10001 pragmatic
WORKDIR /workspace/{{App}}

FROM runtime AS {{App}}
{{RuntimeSetup}}
{{Copies}}
{{WritableDirs}}
{{Env}}
ARG COMPONENT_DIGEST
COPY --from=component /component/component.json /pragmatic/component.json
LABEL ai.pragmatic-tech.component.digest=$COMPONENT_DIGEST
USER 10001
{{Expose}}
{{Healthcheck}}
ENTRYPOINT ["node", "{{EntryScript}}"]
