# @pragmatic-tech-ai/pragmatic-identity-source-oidc

The OIDC base every upstream identity source builds on (discovery, PKCE, JWKS, flow state, HTTP client, claims and group-role mapping, on-behalf-of tokens, the source-pack base) and the generic OIDC source. Split out of `todl-identity-cloud`; the Entra, Google and "Sign in with Pragmatic" sources live in `pragmatic-identity-source-entra`, `pragmatic-identity-source-google` and `pragmatic-identity-source-pragmatic`.

## Verifying realm tokens

`RealmTokenVerifier` (realm-generic; `IRealmTokenVerifier`) verifies a bearer token issued by one realm issuer for a
relying party that receives tokens rather than running a sign-in: the issuer's keys found through its discovery
document (which must name the issuer exactly and an https `jwks_uri`; cached 300 s), the key set cached an hour and
refetched on an unknown key id at most once a minute (rotation), RS256/ES256 only, issuer exact, audience one of the
configured, `azp` one of `AuthorizedParties` when set, `exp` / `nbf` / `iat` (required, not future) within a 60 s
skew, a non-empty `sub`, `RequiredClaims`, and optionally `RequireEmail` / `RequireVerifiedEmail`. It answers a
`RealmTokenPrincipal` (issuer, subject, email, email verified, `RealmRoleClaims` from `roles` / `app_roles`, the
claims) or undefined; it throws `TokenVerifierUnavailableError` only when it cannot decide. The central preset is
`CentralLoginTokenVerifier` in `pragmatic-identity-source-pragmatic`.

A realm on a private CA: `CaBundleFile` (a PEM bundle from a mounted secret or config file) is trusted besides the
public roots (`CaTrustingHttpClient.FromFile`, `OidcHttpClients.Create`). `./testing` has `TlsTestRealm`, an https
realm on a test CA.

## Sources without a directory

PR7: with a non-directory IdP (generic OIDC, Google, Sign in with Pragmatic), a user disabled or deleted in the IdP
keeps access until their current session expires, because nothing can tell the platform
sooner. Admins who need immediate revocation remove the user's assignments and manual team
rows, or use an IdP with a directory API. Those packs expose no directory source, so the host
uses a non-authoritative snapshot.
