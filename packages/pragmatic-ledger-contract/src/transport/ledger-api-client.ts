import { JsonFields, JsonPostClient, JsonPostUnavailableError } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { LedgerApiLink, LedgerOperation } from '../ledger-api-link.js'
import { LedgerApiError, LedgerErrorCode, LedgerErrorCodes } from '../errors/ledger-api-error.js'
import { ClientView, MyClientReply } from '../dto/client.js'
import type { RegisterClientRequest } from '../dto/client.js'
import { PlanList } from '../dto/plan.js'
import type { PlanView } from '../dto/plan.js'
import { CheckoutReference } from '../dto/checkout.js'
import type { StartCheckoutRequest } from '../dto/checkout.js'
import { CancelSubscriptionRequest, SubscriptionView } from '../dto/subscription.js'

/**
 * The personal cabinet's client for the ledger's internal API: each call carries the link bearer and, for calls made
 * for a customer, that customer's central-login token. Every refusal is a LedgerApiError with the ledger's code; no
 * answer, or an answer that is not the contract's, is `unavailable`.
 */
export class LedgerApiClient
{
    private static readonly CodeField = 'code'
    private static readonly EmptyBody: Readonly<Record<string, never>> = {}

    private readonly client: JsonPostClient

    public constructor(baseUrl: string, private readonly credential: InternalApiCredential, timeoutMs: number = JsonPostClient.DefaultTimeoutMs)
    {
        this.client = new JsonPostClient(baseUrl, timeoutMs)
    }

    public async RegisterClient(customerToken: string, request: RegisterClientRequest): Promise<ClientView>
    {
        return this.Call(LedgerOperation.RegisterClient, customerToken, request.ToJson(), body => ClientView.Parse(body))
    }

    public async MyClient(customerToken: string): Promise<ClientView | null>
    {
        return (await this.Call(LedgerOperation.MyClient, customerToken, LedgerApiClient.EmptyBody, body => MyClientReply.Parse(body))).Client
    }

    public async ListPlans(): Promise<readonly PlanView[]>
    {
        return (await this.Call(LedgerOperation.ListPlans, undefined, LedgerApiClient.EmptyBody, body => PlanList.Parse(body))).Plans
    }

    public async StartCheckout(customerToken: string, request: StartCheckoutRequest): Promise<CheckoutReference>
    {
        return this.Call(LedgerOperation.StartCheckout, customerToken, request.ToJson(), body => CheckoutReference.Parse(body))
    }

    public async CancelSubscription(customerToken: string, request: CancelSubscriptionRequest = new CancelSubscriptionRequest()): Promise<SubscriptionView>
    {
        return this.Call(LedgerOperation.CancelSubscription, customerToken, request.ToJson(), body => SubscriptionView.Parse(body))
    }

    private async Call<T>(operation: LedgerOperation, customerToken: string | undefined, body: unknown, parse: (body: unknown) => T): Promise<T>
    {
        let reply
        try
        {
            reply = await this.client.Post(LedgerApiLink.PathOf(operation), body, CustomerCallAuthenticator.Headers(this.credential, customerToken))
        }
        catch (err)
        {
            throw err instanceof JsonPostUnavailableError ? new LedgerApiError(LedgerErrorCode.Unavailable) : err
        }
        if (!reply.Ok)
        {
            const code = JsonFields.IsObject(reply.Body) ? LedgerErrorCodes.Parse(reply.Body[LedgerApiClient.CodeField]) : undefined
            throw new LedgerApiError(code ?? LedgerErrorCode.Unavailable)
        }
        try
        {
            return parse(reply.Body)
        }
        catch
        {
            throw new LedgerApiError(LedgerErrorCode.Unavailable)
        }
    }
}
