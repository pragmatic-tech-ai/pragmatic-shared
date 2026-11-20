import type { CentralLoginSubject } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { RegisterClientRequest, ClientView } from '../dto/client.js'
import type { PlanView } from '../dto/plan.js'
import type { StartCheckoutRequest, CheckoutReference } from '../dto/checkout.js'
import type { CancelSubscriptionRequest, SubscriptionView } from '../dto/subscription.js'

/**
 * What the clients ledger implements behind its internal API. `customer` is the caller's verified central-login
 * subject (the routes verified its token). A refusal is a thrown LedgerApiError with its code.
 */
export interface ILedgerApiService
{
    /** Creates the client with `customer` as its first admin; `already-registered` when they administer one. */
    RegisterClient(customer: CentralLoginSubject, request: RegisterClientRequest): Promise<ClientView>
    /** The client `customer` administers, or null. */
    MyClient(customer: CentralLoginSubject): Promise<ClientView | null>
    ListPlans(): Promise<readonly PlanView[]>
    StartCheckout(customer: CentralLoginSubject, request: StartCheckoutRequest): Promise<CheckoutReference>
    CancelSubscription(customer: CentralLoginSubject, request: CancelSubscriptionRequest): Promise<SubscriptionView>
}
