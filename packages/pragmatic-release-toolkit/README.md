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

Depends on `pragmatic-component`.
