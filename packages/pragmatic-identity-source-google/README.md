# @pragmatic-tech-ai/pragmatic-identity-source-google

Google identity source: its profile; builds on `pragmatic-identity-source-oidc`. Split out of `todl-identity-cloud`.

The Google source exposes no directory source; see "Sources without a directory" in `pragmatic-identity-source-oidc` for what that means for revocation.

The cross-provider tests (Entra and Google side by side) live here, with a dev dependency on `pragmatic-identity-source-entra`.
