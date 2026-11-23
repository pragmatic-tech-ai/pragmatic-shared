# @pragmatic-tech-ai/pragmatic-customer-api-contract

The personal cabinet's operational calls: cabinet → platform edge (public, the customer's central-login token as the
bearer) → platform admin console (internal, the edge's link bearer plus the customer's token, verified by the
console). Design: `dev-kit/docs/superpowers/specs/2026-11-20-d2-contracts-design.md`.

| Operation | Request | Answer | Gated by |
|---|---|---|---|
| `create-tenant` | `CreateTenantRequest` | `TenantView` | `create-tenant` |
| `list-tenants` | `ListTenantsRequest` | `TenantList` | admin only |
| `start-enrolment` | `StartEnrolmentRequest` (level: standalone, enrolled, delegated, hosted) | `EnrolmentStart` | `enrol-hive` (not standalone) |
| `list-hives` | `ListHivesRequest` | `HiveList` (level, home, health, environment reports) | admin only |
| `start-domain-verification` | `DomainVerificationRequest` | `DomainVerification` (TXT record) | `verify-email-domain` |
| `check-domain-verification` | `DomainVerificationRequest` | `DomainVerification` | admin only |
| `leave-hive` | `LeaveHiveRequest` | `HiveView` (health gone) | admin only |

Public paths `/api/customer/v1/<operation>` (edge), internal `/internal/customer/v1/<operation>` (console).

- `CustomerApiClient`: the cabinet's client; refusals are `CustomerApiError` (`CustomerErrorCode`, a
  `NotEntitledReason` for `not-entitled`, and for `rate-limited` the `Retry-After` seconds). The edge's own refusals
  have codes too: `not-found` (404, not an operation it carries), `too-large` (413), `rate-limited` (429).
- `CustomerApiRelay`: the edge's relay (never verifies or keeps the customer's token; `not-signed-in` without one,
  `unavailable` when the console does not answer).
- `CustomerApiRoutes(service, authenticator)` and `CustomerApiGate` (admin of the client, then the entitlement
  decision) for the console's `ICustomerApiService`.

Dependencies: the workspace's `pragmatic-app-host` and `pragmatic-entitlements-contract`.
