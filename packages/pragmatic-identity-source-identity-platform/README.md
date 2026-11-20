# @pragmatic-tech-ai/pragmatic-identity-source-identity-platform

Google Identity Platform as an identity source of a realm sign-in service (the central realm, `central`, at
`login.pragmatic-tech.ai`). The login page signs the person in with Identity Platform and posts the ID token; this
source verifies it and maps it to a realm account. Builds on `pragmatic-identity-source-oidc` (HTTP client,
directory, claims policy).

## Entries

- **main**: `IdentityPlatformPack` (an `IIdentityProviderPack`; one authenticator, `AuthMethod.Oidc`, whose presented
  secret is the ID token), `IdentityPlatformTokenVerifier`, `IdentityPlatformKeySet`, `IdentityPlatformSettings`,
  `IdentityPlatformAccountMapper`, `IdentityPlatformClientConfig`.
- **`./client`** (browser-safe, no dependencies): `IdentityPlatformRestClient` driving the identitytoolkit v1 REST
  endpoints (`accounts:signUp`, `:signInWithPassword`, `:sendOobCode` for verification and password reset,
  `:lookup`), `IdentityPlatformPageConfig`, `IdentityPlatformRestError` (Identity Platform's error code).
- **`./testing`**: `FakeIdentityPlatform` (test JWKS, Identity-Platform-shaped ID tokens), `FakeIdentityPlatformHttp`
  (the JWKS endpoint), `FakeIdentityPlatformRest` (the REST endpoints as a `fetch`).

## Settings (`IdentityConfig.ProviderSettings`)

| Key | Meaning |
|---|---|
| `projectId` | required: the Google Cloud project (`pragmatic-identity` for the central realm) |
| `apiKeyRef` | required: secret reference to the browser API key (public by design, restricted by referrer and API) |
| `providers` | comma-separated provider ids the realm accepts: `password`, `google.com`; default `password`; anonymous is never accepted |
| `tenantId` | the Identity Platform tenant, if the project uses multi-tenancy; tokens of other tenants are refused |
| `maxAuthAgeSeconds` | how old the sign-in (`auth_time`) may be when the token is posted; default 600 |
| `authDomain` | for the client SDK's popup flows; default `<projectId>.firebaseapp.com` |

## Verification

RS256 under a current key of Google's securetoken JWKS (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`,
cached an hour, refetched on an unknown key id at most once a minute); `iss` = `https://securetoken.google.com/<projectId>`;
`aud` = project id; `exp` in the future, `iat` and `auth_time` not in the future (60 s tolerance); a non-empty `sub`
(the uid, the realm account's subject); the provider (`firebase.sign_in_provider`) enabled; and for `password`
accounts `email_verified` true. Every failure is a typed `IdentityPlatformRejection`; the authenticator turns them into
one generic reason, except "email not verified" (the page then offers to resend the verification email).

The realm account: subject = uid; claims `email`, `name`, `email_verified`, `sign_in_provider`; no groups (Identity
Platform carries none; the realm's role mapping assigns roles to accounts).

No directory API: an account disabled in Identity Platform keeps access until its realm session expires.
