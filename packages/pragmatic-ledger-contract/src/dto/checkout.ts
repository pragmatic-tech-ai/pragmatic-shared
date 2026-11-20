import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKinds } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { PaddleReference } from './paddle-reference.js'

/** `start-checkout`: the plan the caller's client wants to buy. */
export class StartCheckoutRequest
{
    private static readonly PlanIdField = 'PlanId'
    private static readonly Members: readonly string[] = [StartCheckoutRequest.PlanIdField]

    public constructor(public readonly PlanId: string)
    {
    }

    public static Parse(value: unknown): StartCheckoutRequest
    {
        const fields = JsonFields.Of(value).OnlyKnown(StartCheckoutRequest.Members)
        return new StartCheckoutRequest(fields.String(StartCheckoutRequest.PlanIdField, { Pattern: ClientKinds.IdPattern }))
    }

    public ToJson(): { PlanId: string }
    {
        return { PlanId: this.PlanId }
    }
}

/** Who runs the checkout. */
export enum CheckoutProvider
{
    Paddle = 'paddle',
}

export interface CheckoutReferenceJson
{
    Provider: CheckoutProvider
    TransactionId: string
    CheckoutUrl: string | null
}

/**
 * What the cabinet needs to open Paddle's checkout: the transaction the ledger created (Paddle.js opens it by id) and,
 * when the ledger has a default payment link, Paddle's hosted checkout URL for it. References only, no amounts.
 */
export class CheckoutReference
{
    private static readonly Field = { Provider: 'Provider', TransactionId: 'TransactionId', CheckoutUrl: 'CheckoutUrl' } as const
    private static readonly Members: readonly string[] = Object.values(CheckoutReference.Field)
    private static readonly Providers: readonly CheckoutProvider[] = Object.values(CheckoutProvider)

    public constructor(public readonly TransactionId: string, public readonly CheckoutUrl: string | null = null, public readonly Provider: CheckoutProvider = CheckoutProvider.Paddle)
    {
    }

    public static Parse(value: unknown): CheckoutReference
    {
        const F = CheckoutReference.Field
        const fields = JsonFields.Of(value).OnlyKnown(CheckoutReference.Members)
        const provider = fields.Enum(F.Provider, CheckoutReference.Providers)
        return new CheckoutReference(
            fields.String(F.TransactionId, { Pattern: PaddleReference.IdPattern }),
            fields.NullableString(F.CheckoutUrl, { Max: PaddleReference.MaxUrlLength, Pattern: PaddleReference.UrlPattern }),
            provider)
    }

    public ToJson(): CheckoutReferenceJson
    {
        return { Provider: this.Provider, TransactionId: this.TransactionId, CheckoutUrl: this.CheckoutUrl }
    }
}
