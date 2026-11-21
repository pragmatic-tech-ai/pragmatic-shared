# @pragmatic-tech-ai/pragmatic-release-toolkit

The platform release toolkit, lifted from pragmatic-server by the container split (dev-kit A3):

- releases: `ReleaseTag`, `ReleaseApp` / `ReleaseApps`, `Channel`, the signed release descriptor
  (`ReleaseDescriptorCodec`, `ReleaseSignature`), `ReleaseRegistry`, `ReleaseTrustKeys`, `ReleasePublisher` and its
  command `pragmatic-release-publish` (`check --tag <ref>`, `publish ...`; the trust directory defaults to
  `release-keys` under the working directory). The publish chain imports only node built-ins, so it runs from a
  checkout without `npm install`.
- images: `OciRegistryClient`, `ImageSigner`, `CryptoImageVerifier`, `PinnedImageVerifier` (`VerifiedImage`),
  `FileKeyStore`, the `IImageDigest` and `ISignatureStore` seams, `ComponentImageLabel`, and
  `scripts/check-component-label.sh <image>...` (the image's `/pragmatic/component.json` hashes to its label).
- UI artifacts: `UiArtifact`, `UiArtifactSigner` / `UiArtifactVerifier`.
- component descriptors: `ComponentDescriptorSet` (a vendored, digest-pinned set), `ComponentDescriptorCli` over the
  caller's `IReleaseComponentSource`, and its command `pragmatic-component-descriptors --components <module> emit-all |
  emit | vendor` (the module exports `Components`).
- the image closure check: `ClosureCheck` and the command `pragmatic-closure-check [<workspace root>]`, run in the
  repository whose images are checked; its options (`Manifest`, `Dockerfile`, `Siblings`, `CompiledRoots`, `Apps`)
  come from that repository's `package.json` field `pragmaticClosureCheck`. It needs esbuild and does not declare it:
  it loads the one in the repository's `node_modules` (tsx brings it; install `esbuild` as a dev dependency otherwise),
  else the one beside this package.
- the container repository template: `ContainerTemplate.Render({ App, Entry, UiDirs, ExtraCopies, Workspaces?, Assets? })`
  (path to content), `ContainerTemplate.ClosureCheckOptions(...)` (the repository package.json's `pragmaticClosureCheck`
  field) and the command `pragmatic-container-template render --app <app> --entry <path> [--ui <dir>]... [--copy <path>]...
  [--asset <from>=<to>]... --out <dir>`, filled from `templates/container` with the per-app facts of `ContainerProfiles`
  (ports, health check, apt packages, environment, multi-arch, image test, Helm chart, the dev packages TODL imports at
  runtime, the closure check, the manifest the release version comes from). The command reads the npm workspaces from
  `<out>/package.json` (`ContainerWorkspaces`: folders and `<dir>/*`) and merges the `pragmaticClosureCheck` field into
  it (printing it while there is no package.json). It renders `Dockerfile` (stages `deps` (the manifests and lock, then
  `npm ci`) → `compile` (the tree, the build, the assets, the UIs, the closure check) → `component-set` / `components` →
  `component` → `build` (`npm prune --omit=dev`, keeping esbuild and typescript where TODL is reached) → `runtime` →
  `<app>`; every package from GitHub Packages through the lock, the npmrc only as the BuildKit secret `npmrc`, the
  runtime as user 10001 under `/workspace/<app>`, the layout `pragmatic-closure-check` reads), `docker-bake.hcl`
  (targets `components` and `<app>`), `.npmrc` (token from `NODE_AUTH_TOKEN`), `.dockerignore`, the tsconfigs,
  `.gitattributes`, `.gitignore` and the caller workflows `.github/workflows/ci.yml` / `release.yml` on
  pragmatic-shared's reusable `container-ci.yml` / `container-release.yml` (`@main`, this organisation's own public
  repository). The entry is `[<workspace>/]src/<path>.ts`; the descriptor comes from
  `[<workspace>/]dist/release-components.js`, which exports `Components = new ContainerComponentSource(app, () =>
  <descriptor>)`. pragmatic-postgres keeps its own Dockerfile (its entry): it gets `components.Dockerfile` (the
  descriptor build) and a bake file whose image target reads the descriptor from the `components` build context.
- the reusable workflows (repository root `.github/workflows`): `container-ci.yml` (inputs `app`, `node-test-glob`,
  `ui-dirs`, `image-test`, `arm64`, `helm-chart`, `node`, `closure-check`; secret `PACKAGES_TOKEN`, absent on a fork's
  pull request, which then skips with a warning) and `container-release.yml` (on the caller's `v<semver>` tag, equal to
  the version of input `version-manifest`; build and test, per-arch bake pushed by digest, `imagetools` join under
  `:<version>` and `:git-<sha>`, output `digest`, `component.json` and `digest.txt` on the tag's GitHub release). The
  nine GHCR packages were created by pragmatic-server: until a package grants the new repository Actions access, its
  GITHUB_TOKEN gets 403 on push, so the release takes an optional secret `GHCR_TOKEN` (write:packages) and logs in with
  it when given. Neither workflow reads a release signing key.

Depends on `pragmatic-component`.
