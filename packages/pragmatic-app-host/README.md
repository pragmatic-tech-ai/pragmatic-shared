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
- `JsonApi`, `ProblemMapper`, `HttpProblem`, `BodyTooLargeError`.
- `HostAllowList`, `OriginGuard` (trusted-proxy scheme), `ClientAddress` (trusted-proxy last hop, IP only).
- `RateLimiter`, `LoginThrottle` over `IThrottleRepository` (in memory, or `SqlThrottleRepository`, shared by
  replicas).
- `SessionCookie`, `SessionStore` over `ISessionRepository` (opaque token stored as its SHA-256 digest; subject and
  claims; fixed or sliding `SessionPolicy`; revocation fails closed; `Rotate`), `SessionGate`.
- `WsTicketStore` over `ITicketRepository`: single-use WebSocket tickets in the subprotocol.
- `OidcRelyingParty` + `OidcLoginEndpoint` (begin, callback, session, logout) with an application-supplied
  `IOidcClientProvider`; flow state in any `IOidcFlowStateStore` (`SqlOidcFlowStateStore` in production);
  `CaTrustingHttpClient` for a realm on a private CA.
- `PasswordLoginEndpoint` over an application's `IPasswordAuthenticator` (optional break-glass sign-in).
- `SessionEndpoint`, `WsTicketEndpoint`.
- `AuditTrail` over `IAuditRepository`.

Every repository has an in-memory implementation (tests) and a Postgres one (`Sql*Repository.Open(session)`, its
schema applied by `SqlMigrationRunner`: modules `app_host.sessions`, `app_host.audit`, `app_host.ws_tickets`,
`app_host.throttles`).

Dependencies: the workspace's `pragmatic-identity`, `pragmatic-identity-source-oidc` and `pragmatic-realm-adapters`,
and `ws`.
