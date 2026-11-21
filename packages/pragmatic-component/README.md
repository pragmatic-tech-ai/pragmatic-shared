# @pragmatic-tech-ai/pragmatic-component

Component descriptors: what one released version of a container supports. A descriptor names the component and its
version, the options it supports (e.g. identity sources) with each option's settings (type, required, default,
secret or not, description), the application roles it declares, the storage it needs (a Postgres database or not)
and the ports and health endpoint it serves.

- `ComponentDescriptorBuilder` declares a descriptor fluently and enforces its rules; `ComponentDescriptor` is
  immutable, writes canonical JSON (sorted keys, no whitespace) and gives its `ContentDigest()` (`sha256:<hex>`).
- `ComponentDescriptorCodec` serialises and strictly parses the JSON form (schema 1).
- `ConfigurationSchema` derives the JSON Schema (draft 2020-12) of the component's configuration documents.
- `ConfigurationValidator` validates a configuration document (`{ "options": { "<option>": { "<setting>": value } } }`)
  against the descriptor: unknown options and settings, missing required settings, wrong types, and literal values in
  secret settings are reported as structured errors (JSON pointer, code, message); a valid document resolves with
  defaults filled in.
- `SecretReference` is what a secret setting holds: `secret:<store>/<name>[@<version>]`, a reference into the realm's
  secrets home, never the secret itself.
- `InternalApiCredential` (`InternalApiSecretError`): one end's identity on an internal link between the platform's
  servers, an HMAC-SHA256 bearer from a shared secret and a per-link label, matched in constant time. Here because this
  package takes no dependency and no peer: the platform edge's link reaches it without the TODL peers of
  pragmatic-app-host, which re-exports it.

No dependencies.
