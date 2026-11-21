# {{App}} (rendered by pragmatic-container-template), in two steps. The first exports the component descriptor, its
# digest and the override that labels the image with that digest into .components (a Node build of the repository's
# descriptor class, components.Dockerfile); the second bakes the image from the repository's own {{EntryDockerfile}}, which
# reads the descriptor from the `components` build context and refuses one that does not hash to COMPONENT_DIGEST:
#   NPMRC_FILE=$HOME/.npmrc docker buildx bake -f docker-bake.hcl --allow=fs.read=$HOME/.npmrc components
#   VERSION=0.1.0 GIT_SHA=$(git rev-parse HEAD) docker buildx bake -f docker-bake.hcl \
#     -f .components/docker-bake.components.json {{App}}
# NPMRC_FILE names an .npmrc able to read @pragmatic-tech-ai packages from GitHub Packages; it reaches the components
# build only as the BuildKit secret `npmrc`, never as a layer. The image itself installs no package.

variable "VERSION" {
  default = "dev"
}

variable "GIT_SHA" {
  default = "local"
}

variable "REGISTRY" {
  default = "ghcr.io/pragmatic-tech-ai"
}

variable "NPMRC_FILE" {
  default = ""
}

# Comma-separated; CI and the release bake one arch per native runner (PLATFORMS=linux/arm64 there).
variable "PLATFORMS" {
  default = "linux/amd64"
}

group "default" {
  targets = ["{{App}}"]
}

# Step one: the component descriptor, its digest and the bake override, exported as files. Not an image.
target "components" {
  context    = "."
  dockerfile = "components.Dockerfile"
  target     = "components"
  # Without NPMRC_FILE the build stops at its first `required=true` secret mount, naming the missing secret.
  secret     = NPMRC_FILE == "" ? [] : ["id=npmrc,src=${NPMRC_FILE}"]
  platforms  = [split(",", PLATFORMS)[0]]
  output     = ["type=local,dest=.components"]
}

target "{{App}}" {
  context    = "{{EntryContext}}"
  dockerfile = "{{EntryDockerfile}}"
  platforms  = split(",", PLATFORMS)
  tags       = ["${REGISTRY}/{{App}}:${VERSION}", "${REGISTRY}/{{App}}:git-${GIT_SHA}"]
  # The descriptor the first step exported.
  contexts = {
    components = ".components"
  }
  # No version or revision label: either would change the image config (so its digest) on every release.
  labels = {
    "org.opencontainers.image.source" = "https://github.com/pragmatic-tech-ai/{{App}}"
  }
}
