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
- **Start step.** `ComponentStartConfiguration.ApplyOrExit({ Declaration, Env })` is the first line of every hive
  component's `Main`: no mounted file leaves the environment as it is; a file that does not read, validate or resolve
  exits with code 78 and the reason. Otherwise `ConfigurationEnvironmentOverlay` lays the configuration over the
  environment by the variable each declared setting names (`source`): values encoded per type
  (`SettingValueEncoding`: a list is JSON array text, `SettingValueEncoding.ReadList` reads it and the comma form), a
  value equal to the descriptor default does not override a variable already set, and a secret is written to
  `/run/pragmatic/secrets/<option>.<setting>` (mode 0400, the directory emptied first) with its `<source>_FILE`
  variable pointing at it; `SecretVariable.Read` is how a component reads such a setting. The default secret store
  `file` is `MountedSecretStore` over `/run/secrets/pragmatic/<component>` (the console-written Secret
  `pragmatic-secrets-<component>`).
