import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKinds, EntitlementLimits } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { PaddleReference } from './paddle-reference.js'

export interface PlanViewJson
{
    PlanId: string
    Name: string
    Description: string
    Limits: Record<string, number>
    PaddlePriceId: string | null
}

/**
 * A plan as a customer sees it: its limits and, when it can be bought, Paddle's price id. No amounts: the cabinet
 * shows the price from Paddle (its price preview, localised and taxed by Paddle). A plan without a price id is not
 * bought through checkout (an internal plan, or later a free plan the ledger grants).
 */
export class PlanView
{
    public static readonly MaxDescription = 2000
    private static readonly Field = { PlanId: 'PlanId', Name: 'Name', Description: 'Description', Limits: 'Limits', PaddlePriceId: 'PaddlePriceId' } as const
    private static readonly Members: readonly string[] = Object.values(PlanView.Field)

    public constructor(
        public readonly PlanId: string,
        public readonly Name: string,
        public readonly Description: string,
        public readonly Limits: EntitlementLimits,
        public readonly PaddlePriceId: string | null)
    {
    }

    public get Purchasable(): boolean
    {
        return this.PaddlePriceId !== null
    }

    public static Parse(value: unknown, path?: string): PlanView
    {
        const F = PlanView.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(PlanView.Members)
        return new PlanView(
            fields.String(F.PlanId, { Pattern: ClientKinds.IdPattern }),
            fields.String(F.Name, { Max: ClientKinds.MaxNameLength }),
            fields.String(F.Description, { Min: 0, Max: PlanView.MaxDescription }),
            EntitlementLimits.Read(fields),
            fields.NullableString(F.PaddlePriceId, { Pattern: PaddleReference.IdPattern }))
    }

    public ToJson(): PlanViewJson
    {
        return { PlanId: this.PlanId, Name: this.Name, Description: this.Description, Limits: this.Limits.ToJson(), PaddlePriceId: this.PaddlePriceId }
    }
}

/** `list-plans`: the plans on offer. */
export class PlanList
{
    public static readonly MaxPlans = 100
    private static readonly PlansField = 'Plans'
    private static readonly Members: readonly string[] = [PlanList.PlansField]

    public constructor(public readonly Plans: readonly PlanView[])
    {
    }

    public static Parse(value: unknown): PlanList
    {
        const fields = JsonFields.Of(value).OnlyKnown(PlanList.Members)
        return new PlanList(fields.Array(PlanList.PlansField, PlanList.MaxPlans, (entry, path) => PlanView.Parse(entry, path)))
    }

    public ToJson(): { Plans: PlanViewJson[] }
    {
        return { Plans: this.Plans.map(plan => plan.ToJson()) }
    }
}
