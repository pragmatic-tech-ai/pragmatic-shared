# pragmatic-shared

The platform packages shared by the Pragmatic containers, under their `pragmatic-` names (see
`dev-kit/docs/platform-model/repository-map.md`). One npm workspace, one version for every package (starting at
`0.1.0`), published to GitHub Packages under `@pragmatic-tech-ai`.

| Package | Was | What it is |
|---|---|---|
| `pragmatic-identity` | `todl-identity` | contracts: principal, realm, session, grants, identity-source seams, realm roles and role claims |
| `pragmatic-identity-realm` | `todl-identity-host` | realm services: directory, audit, the realm, tenant roles, role mapping and resolution |
| `pragmatic-identity-store` | `todl-identity-node` | stores: accounts, sessions, grants, tokens, secrets |
| `pragmatic-identity-source-local` | `todl-identity-local` | local-accounts source (argon2id, encrypted store, service tokens) |
| `pragmatic-identity-source-oidc` | `todl-identity-cloud` (split per source) | the OIDC base every upstream source builds on (discovery, PKCE, JWKS, flow state, HTTP client, claims and group-role mapping, on-behalf-of tokens, the source-pack base) and the generic OIDC source |
| `pragmatic-identity-source-entra` | `todl-identity-cloud` (split per source) | Microsoft Entra source: its profile and the Microsoft Graph directory sync; builds on `pragmatic-identity-source-oidc` |
| `pragmatic-identity-source-google` | `todl-identity-cloud` (split per source) | Google source: its profile; builds on `pragmatic-identity-source-oidc` |
| `pragmatic-identity-source-identity-platform` | (new) | Google Identity Platform source: ID-token verification (securetoken JWKS, issuer, audience, sign-in age, verified email), realm-account mapping, the login page's client config, a browser-safe REST client (`./client`) and a fake Identity Platform (`./testing`) |
| `pragmatic-identity-source-pragmatic` | (new) | "Sign in with Pragmatic": a generic-OIDC profile preset to the central realm's issuer `https://login.pragmatic-tech.ai/realms/central`; builds on `pragmatic-identity-source-oidc` |
| `pragmatic-realm-adapters` | `todl-platform-cloud` | shared base of the per-realm adapters (storage, secrets, SQL; SQL role mappings and application catalogue) |
| `pragmatic-realm-custom` | `todl-platform-node` | adapters for the custom realm option (self-hosted, Node) |
| `pragmatic-realm-gcp` | `todl-platform-gcp` | adapters for the GCP realm option |
| `pragmatic-realm-aws` | `todl-platform-aws` | adapters for the AWS realm option |
| `pragmatic-realm-azure` | `todl-platform-azure` | adapters for the Azure realm option |
| `pragmatic-component` | (new) | component descriptors: what a released container supports (options, settings and which are secret, application roles, storage, endpoints), its configuration JSON Schema, the configuration validator and secret references |
| `pragmatic-hive-protocol` | (new) | the agent channel protocol: signed envelopes (Ed25519, nonce + freshness window, audience), hive identity and enrolment, platform-signed intents with level semantics and the hive's approvals, closed-shape reports, the host agent's enrolment, capacity, placements and sealed cluster-credential handover, the edge relay's tunnel control; strict codecs, verifiers, a fake channel (`./testing`) |
| `pragmatic-configuration` | (new) | component configuration: the versioned configuration repository (versions validated against the target container's descriptor, optimistic concurrency, apply records; in-memory and Postgres), the applied-configuration `ConfigMap` written next to a deployment, and the runtime reader a component calls at start (descriptor-digest check, secret references resolved through the realm's secret stores) |
| `pragmatic-app-host` | (new) | the server of a Mural application: the ordered request pipeline, declared routes, the UI bundle, JSON API limits, OIDC and password sign-in sessions, claims authorization, audit (Postgres repositories) |
| `pragmatic-entitlements-contract` | (new) | the entitlement statement the clients ledger sends to the platform admin console (client, kind, customer admins, plan limits, state, version), its sender and receiver, the operations it gates |
| `pragmatic-ledger-contract` | (new) | the clients ledger's internal API the personal cabinet calls: register a client, my client, plans, checkout (Paddle references), cancel; DTOs, typed client, routes |
| `pragmatic-customer-api-contract` | (new) | the personal cabinet's operations through the platform edge to the platform admin console: tenants, hive enrolment by level, hives and health, email domains, leaving; DTOs, typed client, edge relay, routes, error codes |
| `pragmatic-app-shell` | (new) | the client shell of a Mural application, speaking `pragmatic-app-host`: sign-in page (OIDC redirect, optional password), session handling and expiry, change-password dialog, one-time-secret page, pending-state holders, the JSON API client base, and their compiled `.mu` views |

The cross-provider tests of the old `todl-identity-cloud` (Entra and Google side by side) live in
`pragmatic-identity-source-google`, which has a dev dependency on `pragmatic-identity-source-entra`.

## Working in the repository

The packages take `@pragmatic-tech-ai/todl-runtime` and `@pragmatic-tech-ai/todl` (and, for `pragmatic-app-shell`,
`@pragmatic-tech-ai/mural`) as peer dependencies on the sibling `todl-runtime`, `TODL` and `Mural` folders (`file:`
peers); build those first. A peer, not a dependency: a consumer holds one
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
