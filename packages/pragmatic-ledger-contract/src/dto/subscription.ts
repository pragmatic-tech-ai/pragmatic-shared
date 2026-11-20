import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKinds } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { PaddleReference } from './paddle-reference.js'

/** Where a client's subscription stands (Paddle's states, plus `pending` between checkout and the first payment). */
export enum SubscriptionState
{
    Pending = 'pending',
    Trialing = 'trialing',
    Active = 'active',
    PastDue = 'past-due',
    Paused = 'paused',
    Cancelled = 'cancelled',
}

/** When a cancellation takes effect. */
export enum CancelWhen
{
    PeriodEnd = 'period-end',
    Immediately = 'immediately',
}

export interface SubscriptionViewJson
{
    PlanId: string
    State: SubscriptionState
    PaddleSubscriptionId: string | null
    CurrentPeriodEnd: string | null
    CancelsAt: string | null
}

/** The customer's view of their subscription: plan, state and Paddle's reference, no amounts. A plan granted without
 *  Paddle (an internal or a free plan) has no Paddle subscription id. */
export class SubscriptionView
{
    private static readonly Field = { PlanId: 'PlanId', State: 'State', PaddleSubscriptionId: 'PaddleSubscriptionId', CurrentPeriodEnd: 'CurrentPeriodEnd', CancelsAt: 'CancelsAt' } as const
    private static readonly Members: readonly string[] = Object.values(SubscriptionView.Field)
    private static readonly States: readonly SubscriptionState[] = Object.values(SubscriptionState)

    public constructor(
        public readonly PlanId: string,
        public readonly State: SubscriptionState,
        public readonly PaddleSubscriptionId: string | null,
        public readonly CurrentPeriodEnd: Date | null,
        public readonly CancelsAt: Date | null)
    {
    }

    public static Parse(value: unknown, path?: string): SubscriptionView
    {
        const F = SubscriptionView.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(SubscriptionView.Members)
        return new SubscriptionView(
            fields.String(F.PlanId, { Pattern: ClientKinds.IdPattern }),
            fields.Enum(F.State, SubscriptionView.States),
            fields.NullableString(F.PaddleSubscriptionId, { Pattern: PaddleReference.IdPattern }),
            fields.NullableTimestamp(F.CurrentPeriodEnd),
            fields.NullableTimestamp(F.CancelsAt))
    }

    public ToJson(): SubscriptionViewJson
    {
        return {
            PlanId: this.PlanId,
            State: this.State,
            PaddleSubscriptionId: this.PaddleSubscriptionId,
            CurrentPeriodEnd: this.CurrentPeriodEnd?.toISOString() ?? null,
            CancelsAt: this.CancelsAt?.toISOString() ?? null,
        }
    }
}

/** `cancel-subscription`: at the end of the paid period (default) or now. */
export class CancelSubscriptionRequest
{
    private static readonly WhenField = 'When'
    private static readonly Members: readonly string[] = [CancelSubscriptionRequest.WhenField]
    private static readonly Whens: readonly CancelWhen[] = Object.values(CancelWhen)

    public constructor(public readonly When: CancelWhen = CancelWhen.PeriodEnd)
    {
    }

    public static Parse(value: unknown): CancelSubscriptionRequest
    {
        const fields = JsonFields.Of(value).OnlyKnown(CancelSubscriptionRequest.Members)
        return new CancelSubscriptionRequest(fields.OptionalEnum(CancelSubscriptionRequest.WhenField, CancelSubscriptionRequest.Whens, CancelWhen.PeriodEnd))
    }

    public ToJson(): { When: CancelWhen }
    {
        return { When: this.When }
    }
}
