# pragmatic-shared

The platform packages shared by the Pragmatic containers, under their `pragmatic-` names (see
`dev-kit/docs/platform-model/repository-map.md`). One npm workspace, one version for every package (starting at
`0.1.0`), published to GitHub Packages under `@pragmatic-tech-ai`.

| Package | Was | What it is |
|---|---|---|
| `pragmatic-identity` | `todl-identity` | contracts: principal, realm, session, grants, identity-source seams |
| `pragmatic-identity-realm` | `todl-identity-host` | realm services: directory, audit, the realm |
| `pragmatic-identity-store` | `todl-identity-node` | stores: accounts, sessions, grants, tokens, secrets |
| `pragmatic-identity-source-local` | `todl-identity-local` | local-accounts source (argon2id, encrypted store, service tokens) |
| `pragmatic-identity-source-oidc` | `todl-identity-cloud` (split per source) | the OIDC base every upstream source builds on (discovery, PKCE, JWKS, flow state, HTTP client, claims and group-role mapping, on-behalf-of tokens, the source-pack base) and the generic OIDC source |
| `pragmatic-identity-source-entra` | `todl-identity-cloud` (split per source) | Microsoft Entra source: its profile and the Microsoft Graph directory sync; builds on `pragmatic-identity-source-oidc` |
| `pragmatic-identity-source-google` | `todl-identity-cloud` (split per source) | Google source: its profile; builds on `pragmatic-identity-source-oidc` |
| `pragmatic-realm-adapters` | `todl-platform-cloud` | shared base of the per-realm adapters (storage, secrets, SQL) |
| `pragmatic-realm-custom` | `todl-platform-node` | adapters for the custom realm option (self-hosted, Node) |
| `pragmatic-realm-gcp` | `todl-platform-gcp` | adapters for the GCP realm option |
| `pragmatic-realm-aws` | `todl-platform-aws` | adapters for the AWS realm option |
| `pragmatic-realm-azure` | `todl-platform-azure` | adapters for the Azure realm option |
| `pragmatic-component` | (new) | component descriptors: what a released container supports (options, settings and which are secret, application roles, storage, endpoints), its configuration JSON Schema, the configuration validator and secret references |

The cross-provider tests of the old `todl-identity-cloud` (Entra and Google side by side) live in
`pragmatic-identity-source-google`, which has a dev dependency on `pragmatic-identity-source-entra`.

## Working in the repository

The packages take `@pragmatic-tech-ai/todl-runtime` and `@pragmatic-tech-ai/todl` as peer dependencies on the sibling
`todl-runtime` and `TODL` folders (`file:` peers); build those first. A peer, not a dependency: a consumer holds one
copy of each (an object made by a second copy fails `instanceof` against the first one's class). The publish tool
turns each `file:` peer into `^<sibling version>` and refuses one that is not on the registry.

```
npm install
npm run build
npm test
```

`npm install` links the workspace packages to each other locally. `npm run build` builds them in dependency order;
the tests of a package import its dependencies' built `dist`, so build before testing. Test helpers ship from a
`./testing` subpath (`pragmatic-identity/testing`, `pragmatic-identity-source-oidc/testing`), never the main entry.

## Publishing

`npm run publish:packages -- [--dry-run] packages/<name>...` publishes built packages to GitHub Packages from a staged
copy (`tools/publish-packages.ts`, tests in `tools/tests/`, `npm run test:tools`). It refuses a `dist` older than its
`src`, and every package carries the one workspace version.
