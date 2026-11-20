# @pragmatic-tech-ai/pragmatic-identity-source-oidc

The OIDC base every upstream identity source builds on (discovery, PKCE, JWKS, flow state, HTTP client, claims and group-role mapping, on-behalf-of tokens, the source-pack base) and the generic OIDC source. Split out of `todl-identity-cloud`; the Entra and Google sources live in `pragmatic-identity-source-entra` and `pragmatic-identity-source-google`.

## Sources without a directory

PR7: with a non-directory IdP (generic OIDC, Google), a user disabled or deleted in the IdP
keeps access until their current session expires, because nothing can tell the platform
sooner. Admins who need immediate revocation remove the user's assignments and manual team
rows, or use an IdP with a directory API. Those packs expose no directory source, so the host
uses a non-authoritative snapshot.
