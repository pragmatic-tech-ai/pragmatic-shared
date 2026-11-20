# @pragmatic-tech-ai/pragmatic-ledger-contract

The clients ledger's internal API, called by the personal cabinet over the mesh. Design:
`dev-kit/docs/superpowers/specs/2026-11-20-d2-contracts-design.md`.

Every operation is `POST /internal/ledger/v1/<operation>` with the link bearer (`LedgerApiLink.CredentialFromFile`)
and, except `list-plans`, the customer's central-login token in `x-pragmatic-customer-token`, which the ledger
verifies itself:

| Operation | Request | Answer |
|---|---|---|
| `register-client` | `RegisterClientRequest` (kind, name, campaign/invitation code; the first admin is the verified caller) | `ClientView` |
| `my-client` | `{}` | `MyClientReply` (`ClientView` or null) |
| `list-plans` | `{}` | `PlanList` (limits and Paddle price ids, never amounts) |
| `start-checkout` | `StartCheckoutRequest` | `CheckoutReference` (Paddle transaction id, optional hosted checkout URL) |
| `cancel-subscription` | `CancelSubscriptionRequest` (period end by default) | `SubscriptionView` |

- `LedgerApiClient`: the cabinet's typed client; every refusal is a `LedgerApiError` with its `LedgerErrorCode`.
- `LedgerApiRoutes(service, authenticator)`: the ledger mounts them on its `pragmatic-app-host` `RouteTable`; its
  `ILedgerApiService` throws `LedgerApiError` to refuse.

Dependencies: the workspace's `pragmatic-app-host` and `pragmatic-entitlements-contract`.
