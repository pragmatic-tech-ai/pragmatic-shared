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
- **Applied object, runtime reader, start step.** Re-exported from `@pragmatic-tech-ai/pragmatic-configuration-runtime`
  (what a component reads at start, on `pragmatic-component` alone): `AppliedConfiguration` and its codec (the
  `ConfigMap` `pragmatic-config-<component>`), `ConfigurationRuntimeReader`, and `ComponentStartConfiguration`, the
  start step every hive component runs first. See that package's README.
