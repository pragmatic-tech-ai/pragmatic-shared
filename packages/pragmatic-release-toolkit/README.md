# @pragmatic-tech-ai/pragmatic-release-toolkit

The platform release toolkit, lifted from pragmatic-server by the container split (dev-kit A3):

- releases: `ReleaseTag`, `ReleaseApp` / `ReleaseApps`, `Channel`, the signed release descriptor
  (`ReleaseDescriptorCodec`, `ReleaseSignature`), `ReleaseRegistry`, `ReleaseTrustKeys`, `ReleasePublisher` and its
  command `pragmatic-release-publish` (`check --tag <ref>`, `publish --tag ...`; the trust directory defaults to
  `release-keys` under the working directory). The publish chain imports only node built-ins, so it runs from a
  checkout without `npm install`.
- platform releases from a manifest (pragmatic-platform-release's `release.json`: schema 1, the release version, all
  nine apps each as `{ repository, version, digest }`): `ReleaseManifest.Parse` / `Check` / `Inspect` (each image exists
  at its digest and carries a component label equal to the digest of the `component.json` its repository's release
  `v<version>` attached, its `<version>` and `git-<commit of v<version>>` tags name that digest, and `release-<version>`
  is free or names the same digest), the
  `IComponentAssetSource` seam and `GitHubComponentAssetSource` (GitHub REST; the token goes to the API origin only),
  `ReleasePublisher.Assemble` (check only) and `PublishManifest` (schema-2 descriptor: the manifest's digests, the
  labelled component digests, `siblingCommits` = each container repository's tag commit, `serverCommit` = the release
  repository's commit; every image is tagged `release-<version>` (`ReleaseManifest.ImageTagOf`, apart from a
  container release's `<version>` tags), then the descriptor is pushed last; a stopped publish is re-run as is), and the
  commands `pragmatic-release-publish assemble --manifest <path>` (refuses a published version, prints each problem, exit 1
  on any) and `publish
  --manifest <path> --key-id <id> [--trust-dir <dir>] [--release-commit <sha>]` (default `GITHUB_SHA`; the signing key
  from the file `RELEASE_SIGNING_KEY_FILE` names; component assets read with `GITHUB_TOKEN` when set).
  `OciRegistryClient.TagManifest(repo, digest, tag)` re-tags an image manifest or index by its own media type.
- images: `OciRegistryClient`, `ImageSigner`, `CryptoImageVerifier`, `PinnedImageVerifier` (`VerifiedImage`),
  `FileKeyStore`, the `IImageDigest` and `ISignatureStore` seams, `ComponentImageLabel`, and
  `scripts/check-component-label.sh <image>...` (the image's `/pragmatic/component.json` hashes to its label) and
  `scripts/start-smoke.sh <image>` (container-ci.yml's start smoke).
- UI artifacts: `UiArtifact`, `UiArtifactSigner` / `UiArtifactVerifier`.
- component descriptors: `ComponentDescriptorSet` (a vendored, digest-pinned set), `ComponentDescriptorCli` over the
  caller's `IReleaseComponentSource`, and its command `pragmatic-component-descriptors --components <module> emit-all |
  emit | vendor` (the module exports `Components`).
- the image closure check: `ClosureCheck` and the command `pragmatic-closure-check [<workspace root>]`, run in the
  repository whose images are checked; its options (`Manifest`, `Dockerfile`, `Siblings`, `CompiledRoots`, `Apps`)
  come from that repository's `package.json` field `pragmaticClosureCheck`. A file counts as a sibling's only when it
  lies inside that sibling's checkout, so a registry install beside a pragmatic-shared checkout (the dev workspace) is
  the repository's own node_modules, as in CI. It needs esbuild and does not declare it:
  it loads the one in the repository's `node_modules` (tsx brings it; install `esbuild` as a dev dependency otherwise),
  else the one beside this package.
- the container repository template: `ContainerTemplate.Render({ App, Entry, UiDirs, ExtraCopies, Workspaces?, Assets? })`
  (path to content), `ContainerTemplate.ClosureCheckOptions(...)` (the repository package.json's `pragmaticClosureCheck`
  field) and the command `pragmatic-container-template render --app <app> --entry <path> [--ui <dir>]... [--copy <path>]...
  [--asset <from>=<to>]... [--dockerignore <line>]... [--gitignore <line>]... --out <dir>` (`DockerIgnore` /
  `GitIgnore`: lines appended after the profile's, `#` comments allowed), filled from `templates/container` with the per-app facts of `ContainerProfiles`
  (ports, health check, apt packages, environment, multi-arch, image test, start smoke and its refusal pattern,
  `legacy-peer-deps`, the repository's own `.dockerignore` / `.gitignore` lines, Helm chart, the closure check, the
  manifest the release version comes from), so a re-render reproduces the repository's files. The command reads the npm workspaces from
  `<out>/package.json` (`ContainerWorkspaces`: folders and `<dir>/*`) and merges the `pragmaticClosureCheck` field into
  it (printing it while there is no package.json). It renders `Dockerfile` (stages `deps` (the manifests and lock, then
  `npm ci`) → `compile` (the tree, the build, the assets, the UIs, the closure check) → `component-set` / `components` →
  `component` → `build` (`npm prune --omit=dev`; TODL from 0.66.4 on declares the esbuild and typescript it loads as runtime dependencies) → `runtime` →
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
  `ui-dirs`, `image-test`, `arm64`, `helm-chart`, `node`, `closure-check`, `start-smoke` (opt-in, the template
  renders it for every Node app: `scripts/start-smoke.sh` starts the baked image once with no configuration and
  `start-smoke-args`; a module-resolution error, or a non-zero exit whose output does not match `start-smoke-refusal`
  (default `is required|required environment|must be set`), fails; still running after 20 s passes),
  `start-smoke-args`, `start-smoke-refusal`; the repository's `typecheck` script runs after the build when it has one; secret
  `PACKAGES_TOKEN`, absent on a fork's pull request, which then skips with a warning) and `container-release.yml` (on the caller's `v<semver>` tag, equal to
  the version of input `version-manifest`; build and test, per-arch bake pushed by digest, `imagetools` join under
  `:<version>` and `:git-<sha>`, output `digest`, `component.json` and `digest.txt` on the tag's GitHub release). The
  nine GHCR packages were created by pragmatic-server: until a package grants the new repository Actions access, its
  GITHUB_TOKEN gets 403 on push, so the release takes an optional secret `GHCR_TOKEN` (write:packages) and logs in with
  it when given. Neither workflow reads a release signing key.

Depends on `pragmatic-component`.
