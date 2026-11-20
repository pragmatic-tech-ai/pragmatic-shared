# @pragmatic-tech-ai/pragmatic-identity-source-pragmatic

"Sign in with Pragmatic": a generic-OIDC profile preconfigured for the central realm's issuer,
`https://login.pragmatic-tech.ai/realms/central` (the realm sign-in service on `pragmatic-public`); builds on
`pragmatic-identity-source-oidc`. A tenant realm that opts in uses it as an OIDC upstream.

- `PragmaticIdentityProfile`: scopes `openid profile email`; claims `email`, `name`; groups from the central realm's
  `roles` claim (array of strings). The `issuer` setting (`OidcSettingKeys.Issuer`) overrides the central issuer for
  tests and development stacks; discovery is always `<issuer>/.well-known/openid-configuration`.
- `CentralLoginTokenVerifier`: `RealmTokenVerifier` preset to the central issuer (overridable) and requiring an email;
  the relying party gives its audience (its client id at the central realm) and, for a private CA, `CaBundleFile`.
- `PragmaticIdentityPack.Create(options)`: the pack (the OIDC pack base with this profile). Settings `clientId`,
  `redirectUri` and `secretRef` as for any OIDC source.

The central realm has no directory API for its relying parties: see "Sources without a directory" in
`pragmatic-identity-source-oidc`.
