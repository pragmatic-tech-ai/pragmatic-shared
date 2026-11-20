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
  `:lookup`, and for a federated sign-in `:createAuthUri` and `:signInWithIdp`), `IdentityPlatformPageConfig`,
  `IdentityPlatformRestError` (Identity Platform's error code), `IdentityPlatformSession` /
  `IdentityPlatformIdpSession`, `IdentityPlatformAuthUri`, and the transport seam `IIdentityPlatformHttp` (one JSON
  POST) with its default `FetchIdentityPlatformHttp`.
- **`./testing`**: `FakeIdentityPlatform` (test JWKS, Identity-Platform-shaped ID tokens), `FakeIdentityPlatformHttp`
  (the JWKS endpoint), `FakeIdentityPlatformRest` (the REST endpoints as a `fetch`, Google's round trip included:
  `SignInAtProvider(authUri, new FakeFederatedPerson(email, name))` gives the URL Google sends the browser back to;
  its fourth constructor argument lists the email domains Google is authoritative for, default all, so an existing
  account of another domain answers `needConfirmation`).

## The client's transport

`IdentityPlatformRestClient.For(config, fetchFn?)` runs over fetch; `fetchFn` may be the browser's `fetch` passed
unbound (`FetchIdentityPlatformHttp` always calls it with the global object as receiver, never as a method of an
object, which in a browser throws "Illegal invocation"); without it the global fetch is read at call time.
`IdentityPlatformRestClient.WithHttp(config, http)` takes any `IIdentityPlatformHttp`; the constructor's third
argument takes either (since 0.15.0; before, only a fetch).

## Federated sign-in (Google through Identity Platform)

1. `CreateAuthUri("google.com", continueUri, customParameters?)` answers the provider's authorization URL and a session
   id. Google's `redirect_uri` is the continue URI itself, so it must be a redirect URI of the OAuth client behind
   the provider (for the central login: `https://login.pragmatic-tech.ai/__/auth/handler`), on an authorized domain
   of the project. Keep the session id across the round trip (e.g. `sessionStorage`). `customParameters` go to the
   provider (`login_hint`, `prompt=select_account`).
2. The browser goes to the authorization URL; Google sends it back to the continue URI with its answer in the
   **fragment** (Identity Platform asks for `response_type=id_token`).
3. `SignInWithIdp(location.href, sessionId)`: pass the whole URL, fragment included. The answer is an
   `IdentityPlatformIdpSession` (provider, email verified as the provider says, display name, whether the account is
   new) whose `IdToken` the page posts to the realm sign-in service like a password sign-in's. An answer that needs
   confirmation (the email belongs to an account of another, untrusted method) is the error `NEED_CONFIRMATION`; an
   `errorMessage` in a 200 answer is an error with that code.

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
