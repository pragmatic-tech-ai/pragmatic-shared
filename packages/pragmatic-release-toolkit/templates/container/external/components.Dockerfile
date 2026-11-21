# syntax=docker/dockerfile:1
# {{App}}'s component descriptor (rendered by pragmatic-container-template): the image itself is built from the
# repository's own {{EntryDockerfile}}; this file only builds the repository's descriptor class against the
# @pragmatic-tech-ai packages of its lock (GitHub Packages, no sibling checkout) and exports the descriptor, its digest and
# the bake override that hands the image target its COMPONENT_APP and COMPONENT_DIGEST (docker-bake.hcl, `components`).
# The npm credentials reach the build only as the BuildKit secret `npmrc`, never as an ARG, an ENV or a layer.

FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS deps
WORKDIR /workspace/{{App}}
# The manifest and the lock first, so the install layer is reused while they do not change.
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    npm ci --no-audit --no-fund

FROM deps AS compile
COPY . .
RUN npm run build

# {{ComponentsModule}} exports `Components`, an IReleaseComponentSource of this one app (ContainerComponentSource).
FROM compile AS component-set
RUN ./node_modules/.bin/pragmatic-component-descriptors --components {{ComponentsModule}} emit-all --out /components

FROM scratch AS components
COPY --from=component-set /components /
