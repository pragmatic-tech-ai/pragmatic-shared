# @pragmatic-tech-ai/pragmatic-tenant-plane

**Transitional.** The tenant plane both the tenant admin console (`pragmatic-tenant-admin`) and the platform admin
console's co-hosted tenant plane run, lifted out of pragmatic-server by the container split (dev-kit A3 Task 4). C5.3
retires the co-hosted plane and folds this package back into `pragmatic-tenant-admin`; no further versions after that.

- tenant API and tenant sign-in: `tenant-api/` (endpoint, configuration, email domains, events, graph access, log
  socket, rollout client and status), `tenant-auth/` (sessions, session gate, OIDC clients, roles, host resolver,
  desktop sign-in flows, endpoint, targets and relay), the console host, admission and problems, the plane composer;
- environments: records, registry, DTOs, placement, runtimes (in-cluster, no-host, the Docker seam's contract), the
  environment and graph services and the contracts the platform console implements for them
  (`IEnvironmentService`, `IGraphService`, `IIdpService`, `IOwnerSessionRevoker`, `IUiDeployActuator`, `IDockerEnv`,
  `ITenantDirectory`, `ITenantRecordSource`, `IHiveImageSigner`, `IComponentDescriptorSource`, `ISealedSecrets`);
- the hive layer the plane drives: the manifest builder, environment / tenant-admin / IdP workloads, the namespace
  guard, the hive orchestrators (in-cluster, kubectl) and their factory, the effective registry, ingress TLS;
- configuration: the configuration service, targets, diff and the Kubernetes applier;
- records: the JSON / SQL record maps and stores, platform records, the manifest and adoption ledger records, the
  `ISealedSecrets` contract, the master key file, console adverts, registrations and fingerprint keys;
- the environment seed (`src/seed/`: bundle, Northwind compile, conventions, users) with its data: the environment
  templates (`templates/`), the demo seed and the Northwind sample (`environments/`), read relative to the package.

Depends on pragmatic-app-host, pragmatic-component, pragmatic-configuration, pragmatic-identity,
pragmatic-identity-source-oidc, pragmatic-kube, pragmatic-platform-link, pragmatic-realm-adapters,
pragmatic-release-toolkit, pragmatic-protocol, `ws`; TODL and todl-runtime as peers.

pragmatic-protocol is a plain dependency (it carries no TODL), so in the pragmatic-server workspace it may load twice
(the server's sibling checkout and this package's registry copy); nothing passes a protocol object across the two
copies with `instanceof`.

## Upgrade notes

- 0.17.5: environments run `pragmatic-env-server:dev` (EnvironmentWorkloadFactory.ServerImage), no longer the
  monolith's `pragmatic-server:dev`, and the hive agent's default dev image is `pragmatic-hive-agent:dev`. A dev
  environment placed before the upgrade is rolled to the new name on its next bring-up: bake the per-repository dev
  images first (pragmatic-e2e `src/dev/dev-images.ts`), or the hive has nothing to run.
- 0.17.3: an app deployment's `ui-unpack` init container runs the pragmatic-ui-unpack image
  (`WorkloadAppDeployment.unpackImage`, required; default `pragmatic-ui-unpack:dev`), mapped, verified and signed like
  the server image; the tenant-admin container runs its image's own ENTRYPOINT.
