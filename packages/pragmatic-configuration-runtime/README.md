# @pragmatic-tech-ai/pragmatic-configuration-runtime

What a hive component reads at start, on `@pragmatic-tech-ai/pragmatic-component` alone (no Postgres, no TODL), so a
lean container such as the hive agent, the gateway or the UI unpacker can carry it. `pragmatic-configuration` (the
versioned repository the tenant admin console keeps) re-exports everything here.

- **Applied object.** `AppliedConfiguration` is a version as applied: the resolved document (defaults filled in,
  secret references, never secret values) with its descriptor digest and a content hash. `AppliedConfigurationCodec`
  writes it as the `ConfigMap` `pragmatic-config-<component>` (one file, `configuration.json`) and gives the
  pod-template annotation that rolls the deployment when a new version is applied.
- **Runtime reader.** `ConfigurationRuntimeReader` reads the mounted file (default
  `/etc/pragmatic/configuration/configuration.json`, override `PRAGMATIC_CONFIGURATION_FILE`), refuses a configuration
  validated against another descriptor than the container's own, validates it and resolves secret references through
  `SecretStoreDirectory` into a `RuntimeConfiguration`. Secrets come back as `SecretValue`s, which never print.
- **Start step.** `ComponentStartConfiguration.ApplyOrExit({ Declaration, Env })` is the first line of every hive
  component's `Main`: no mounted file leaves the environment as it is; a file that does not read, validate or resolve
  exits with code 78 and the reason. Otherwise `ConfigurationEnvironmentOverlay` lays the configuration over the
  environment by the variable each declared setting names (`source`): values encoded per type
  (`SettingValueEncoding`: a list is JSON array text; `SettingValueEncoding.ReadList` reads it and the comma form), a
  value equal to the descriptor default does not override a variable already set, and a secret is written to
  `/run/pragmatic/secrets/<option>.<setting>` (mode 0400, the directory emptied first) with its `<source>_FILE`
  variable pointing at it; `SecretVariable.Read` is how a component reads such a setting. The default secret store
  `file` is `MountedSecretStore` over `/run/secrets/pragmatic/<component>` (the console-written Secret
  `pragmatic-secrets-<component>`).
