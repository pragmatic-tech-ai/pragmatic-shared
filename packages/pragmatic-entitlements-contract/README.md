# @pragmatic-tech-ai/pragmatic-entitlements-contract

The entitlement statement: what the clients ledger states about one client, sent to the platform admin console over
the mesh. Design: `dev-kit/docs/superpowers/specs/2026-11-20-d2-contracts-design.md`.

- `EntitlementStatement` (schema 1, strict codec): client id, `ClientKind` (organisation or person, one model),
  client name, customer admins (`CentralLoginSubject`: issuer, subject, email), plan id, `EntitlementLimits` (named
  integer limits; no price: a free plan is a plan with its own limits), `EntitlementState` (active or suspended), a
  per-client `Version` that only grows, and `IssuedAt`.
- `Entitlement.Decide(operation, currentUsage)` / `Allows(...)` for the gated `EntitledOperation`s (`create-tenant`
  → `tenants`, `enrol-hive` → `hives`, `verify-email-domain` → `verified-domains`): `allowed`, `suspended`,
  `not-in-plan` (no such limit), `limit-reached`.
- `EntitlementSender` (ledger) → `POST /internal/entitlements/v1/statements` → `EntitlementReceiver` (platform admin
  console; a `RouteDefinition` for `pragmatic-app-host`, or transport-free `Receive`): HMAC bearer of the link
  (`EntitlementsLink.CredentialFromFile`), strict decoding, per-client serialisation, newer versions handed to the
  application's `IEntitlementSink`, equal ones `duplicate`, older ones `stale`.
- Shared by the two API contracts: `CentralLoginSubject`, `ICentralLoginVerifier` (the application verifies the
  central login's ID tokens), `CentralLoginSubjectVerifier` (the `ICentralLoginVerifier` over a realm token verifier:
  `CentralLoginTokenVerifier` of `pragmatic-identity-source-pragmatic`, or a `RealmTokenVerifier` for a configured
  issuer), `CustomerCallAuthenticator` (link bearer plus the customer's own token in `x-pragmatic-customer-token`).

Dependencies: the workspace's `pragmatic-app-host` and `pragmatic-identity-source-oidc`.
