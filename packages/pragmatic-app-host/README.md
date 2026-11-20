# @pragmatic-tech-ai/pragmatic-app-host

The server of a Mural application (the platform admin console, the tenant admin console, the personal cabinet, the
clients ledger): one ordered request pipeline, declared routes, the UI bundle, JSON API limits, sign-in sessions,
authorization from claims, and audit. Design: `dev-kit/docs/superpowers/specs/2026-11-20-a4-app-host-design.md`.

## Pipeline

`AppHost` is a node:http server with WebSocket upgrade dispatch. Every request runs, in order:

1. **health**: `/healthz`, `/readyz` (any Host, no session);
2. **allowed Host** (`HostAllowList`, loopback always allowed): 403 otherwise;
3. **body type**: a body that is not `application/json` is 415;
4. **Origin** (`OriginGuard`): a mutation from another origin is 403, audited as anonymous under the denial
   `RateLimiter` (429 with `Retry-After` once locked);
5. **authentication** (`SessionGate`: the session cookie names a server-side session);
6. **authorization** (`ClaimsAuthorizer`): the route's role against the session's `roles` claim; a mutation that
   names no role is denied;
7. **route**: the declared handler, under the route's body limit (a declared over-limit body is drained and answered
   413 before the handler runs);
8. **UI bundle** (`MuralBundle`) for paths outside the API prefix.

Security headers (`SecurityHeaders`: CSP, `nosniff`, `X-Frame-Options`, `Referrer-Policy`) go on every response.
An authorized mutation is audited once, after its response, with its final status (`AuditTrail`); `Close` awaits the
audit writes still running. Errors map through the application's `ProblemMapper` (error class to status; anything
else is a generic 500).

## Pieces

- `RouteTable`: `{ Method, Pattern, Auth: Public | Session, Role, Audited, BodyLimit, Handler }` routes and socket
  routes; handlers get a `RequestContext` (params, query, session, client address, `ReadJson`, `WriteJson`).
- `MuralBundle`: an explicit root read at load; SPA fallback; `immutable` hashed assets, `no-cache` index; traversal
  guard.
- `JsonApi`, `ProblemMapper`, `HttpProblem` (optional `Code` and `Fields()`, written beside `error`; `BadRequestProblem`
  carries `invalid-request`), `BodyTooLargeError`.
- `JsonFields`: strict reading of a JSON object (strings, integers, booleans, enums, UTC timestamps, arrays, nested
  DTOs, integer maps; unknown members refused), each refusal a 400 naming the member's path, never its value.
- Internal links between the platform's servers: `InternalApiCredential` (HMAC-SHA256 bearer from a shared secret and
  a per-link label; constant-time match; the default label interoperates with the edge to platform admin console
  internal API), `InternalApiGuard` (route-side 401 `unauthorized`), `JsonPostClient` (JSON POST with a deadline and a
  reply cap, any status returned as a `JsonReply`; a transport failure is `JsonPostUnavailableError`).
- `HostAllowList`, `OriginGuard` (trusted-proxy scheme), `ClientAddress` (trusted-proxy last hop, IP only).
- `RateLimiter`, `LoginThrottle` over `IThrottleRepository` (in memory, or `SqlThrottleRepository`, shared by
  replicas).
- `SessionCookie`, `SessionStore` over `ISessionRepository` (opaque token stored as its SHA-256 digest; subject and
  claims; fixed or sliding `SessionPolicy`; revocation fails closed; `Rotate`; `RevokeSubjectWithClaim` ends only
  the subject's sessions carrying one claim value, e.g. one tenant's), `SessionGate`.
- `WsTicketStore` over `ITicketRepository`: single-use WebSocket tickets in the subprotocol. A socket route's `Admit`
  runs after the Host and Origin checks and before the ticket: an `UpgradeRefusal` (status and JSON body) is written
  as plain HTTP before any handshake, so a client reads the refusal status. An unparseable request target is 400.
- `OidcRelyingParty` + `OidcLoginEndpoint` (begin, callback, session, logout) with an application-supplied
  `IOidcClientProvider`; flow state in any `IOidcFlowStateStore` (`SqlOidcFlowStateStore` in production);
  a realm on a private CA through a CA bundle file (`CaBundleFile` on the relying party or per client; the
  `CaTrustingHttpClient` and `OidcHttpClients` of `pragmatic-identity-source-oidc`, re-exported here). With OIDC
  sign-in registered the session cookie defaults to `SameSite=Lax` (the callback is a cross-site redirect back from
  the login page); password-only applications keep `Strict`; a configured mode always wins; the Origin guard still
  refuses foreign mutations. The begin route takes `prompt=create` (sign-up, sent only when the issuer advertises
  `create` in `prompt_values_supported`), a `login_hint` (passed through), and a `return` path that lands the user
  where they started: relative, same-origin, under one of the endpoint's `ReturnPaths` prefixes (`ReturnPathPolicy`),
  carried in the flow state and checked again at the callback; anything else lands on `AfterSignInPath`. A client
  config's `RequiredClaims` (e.g. `iat`, `email`) refuses an ID token without them.
- Upstream token retention (opt-in): a `SessionTokenRetention` on the `SessionGate` keeps each sign-in's ID token (and
  access token if issued) server-side beside the session, sealed by `SessionTokenVault` (AES-256-GCM, key from the
  application's secret and the session bearer) in an `ISessionTokenRepository` (`SqlSessionTokenRepository`); route
  handlers read them with `SessionGate.UpstreamTokens(req)`. A refresh token is redeemed when the tokens fall due;
  without one the session ends with the ID token (less a 30 s margin; `EndWithIdToken: false` keeps the endpoint's
  policy). Logout forgets them.
- `PasswordLoginEndpoint` over an application's `IPasswordAuthenticator` (optional break-glass sign-in).
- `SessionEndpoint`, `WsTicketEndpoint`.
- `AuditTrail` over `IAuditRepository`.

Every repository has an in-memory implementation (tests) and a Postgres one (`Sql*Repository.Open(session)`, its
schema applied by `SqlMigrationRunner`: modules `app_host.sessions`, `app_host.audit`, `app_host.ws_tickets`,
`app_host.throttles`, `app_host.session_tokens`).

Dependencies: the workspace's `pragmatic-identity`, `pragmatic-identity-source-oidc` and `pragmatic-realm-adapters`,
and `ws`.
