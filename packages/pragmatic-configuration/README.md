# @pragmatic-tech-ai/pragmatic-configuration

Component configuration, from the tenant admin console to the running container.

- **Repository.** `IConfigurationRepository` holds, per realm and component (`ConfigurationScope`), an ordered sequence
  of `ConfigurationVersion`s: the document as authored (the `pragmatic-component` shape, secret settings as
  `secret:<store>/<name>[@<version>]` references), the component version and descriptor digest it was validated
  against, the author (a realm subject), created-at and a comment. `Save` validates the document with
  `ConfigurationValidator` against the descriptor of the target container version (literal secrets are rejected) and
  fails with `ConfigurationHeadMovedError` when the version it was based on is no longer the head. Apply records say
  which version was applied to which deployment (`ApplyTarget`: hive, namespace, deployment), when, by whom, with what
  outcome. `InMemoryConfigurationRepository` and `SqlConfigurationRepository` (Postgres, migrated with
  `SqlMigrationRunner`).
- **Applied object.** `AppliedConfiguration` is a version as applied: the resolved document (defaults filled in,
  secret references, never secret values) with its descriptor digest and a content hash. `AppliedConfigurationCodec`
  writes it as the `ConfigMap` `pragmatic-config-<component>` (one file, `configuration.json`) and gives the
  pod-template annotation that rolls the deployment when a new version is applied.
- **Runtime reader.** `ConfigurationRuntimeReader` is what a component calls at start: it reads the mounted file
  (default `/etc/pragmatic/configuration/configuration.json`, override `PRAGMATIC_CONFIGURATION_FILE`), refuses to
  start when the configuration was validated against another descriptor than the container's own, validates it and
  resolves secret references through the realm's secret stores (`SecretStoreDirectory` over `ISecretStore`) into a
  `RuntimeConfiguration`. Secrets come back as `SecretValue`s, which never print their value.
