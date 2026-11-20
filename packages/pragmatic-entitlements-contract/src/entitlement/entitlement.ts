import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitledOperations } from './entitled-operation.js'
import type { EntitledOperation } from './entitled-operation.js'

/** Whether a client may act at all. */
export enum EntitlementState
{
    Active = 'active',
    Suspended = 'suspended',
}

/** The answer to "may this client do this now". */
export enum EntitlementDecision
{
    Allowed = 'allowed',
    Suspended = 'suspended',
    /** The plan carries no limit for the operation. */
    NotInPlan = 'not-in-plan',
    /** The current usage already reaches the limit. */
    LimitReached = 'limit-reached',
}

/**
 * A plan's named integer limits (e.g. `tenants: 1`, `hives: 3`). No price and no assumption that a plan has one: a
 * free plan is a plan with its own limits. A limit that is absent allows nothing (deny by default); there is no
 * "unlimited", a plan states a number.
 */
export class EntitlementLimits
{
    public static readonly NamePattern = /^[a-z][a-z0-9-]{0,62}$/
    public static readonly MaxEntries = 64
    public static readonly Field = 'Limits'
    private static readonly NegativeMessage = 'A limit must be a non-negative safe integer: '
    private static readonly NameMessage = 'Not a limit name: '

    private constructor(private readonly values: ReadonlyMap<string, number>)
    {
    }

    public static Of(values: Readonly<Record<string, number>>): EntitlementLimits
    {
        const map = new Map<string, number>()
        for (const [name, value] of Object.entries(values))
        {
            if (!EntitlementLimits.NamePattern.test(name))
            {
                throw new RangeError(EntitlementLimits.NameMessage + name)
            }
            if (!Number.isSafeInteger(value) || value < 0)
            {
                throw new RangeError(EntitlementLimits.NegativeMessage + name)
            }
            map.set(name, value)
        }
        return new EntitlementLimits(map)
    }

    /** The `Limits` member of `fields`. */
    public static Read(fields: JsonFields): EntitlementLimits
    {
        return new EntitlementLimits(fields.IntegerMap(EntitlementLimits.Field, EntitlementLimits.NamePattern, EntitlementLimits.MaxEntries, { Min: 0 }))
    }

    public Get(name: string): number | undefined
    {
        return this.values.get(name)
    }

    public get Names(): readonly string[]
    {
        return [...this.values.keys()]
    }

    public ToJson(): Record<string, number>
    {
        return Object.fromEntries(this.values)
    }
}

/** A client's state and limits: what the platform admin console checks before a gated customer operation. */
export class Entitlement
{
    private static readonly UsageMessage = 'Current usage must be a non-negative safe integer'

    public constructor(public readonly State: EntitlementState, public readonly Limits: EntitlementLimits)
    {
    }

    /** `currentUsage`: how much of the operation's limit the client already uses (e.g. its tenant count). */
    public Decide(operation: EntitledOperation, currentUsage: number): EntitlementDecision
    {
        if (!Number.isSafeInteger(currentUsage) || currentUsage < 0)
        {
            throw new RangeError(Entitlement.UsageMessage)
        }
        if (this.State === EntitlementState.Suspended)
        {
            return EntitlementDecision.Suspended
        }
        const limit = this.Limits.Get(EntitledOperations.LimitOf(operation))
        if (limit === undefined)
        {
            return EntitlementDecision.NotInPlan
        }
        return currentUsage >= limit ? EntitlementDecision.LimitReached : EntitlementDecision.Allowed
    }

    public Allows(operation: EntitledOperation, currentUsage: number): boolean
    {
        return this.Decide(operation, currentUsage) === EntitlementDecision.Allowed
    }
}
