import { HttpProblem } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementDecision } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

/** The codes a customer API call can fail with. */
export enum CustomerErrorCode
{
    InvalidRequest = 'invalid-request',
    InvalidDomain = 'invalid-domain',
    Unauthorized = 'unauthorized',
    NotSignedIn = 'not-signed-in',
    NotAdminOfClient = 'not-admin-of-client',
    NotEntitled = 'not-entitled',
    UnknownTenant = 'unknown-tenant',
    UnknownHive = 'unknown-hive',
    TenantTaken = 'tenant-taken',
    DomainTaken = 'domain-taken',
    Unavailable = 'unavailable',
}

/** Why a client is not entitled (the entitlement decisions other than allowed). */
export enum NotEntitledReason
{
    Suspended = 'suspended',
    NotInPlan = 'not-in-plan',
    LimitReached = 'limit-reached',
}

/** Each code's status and fixed message. */
export class CustomerErrorCodes
{
    public static readonly All: readonly CustomerErrorCode[] = Object.values(CustomerErrorCode)
    public static readonly Reasons: readonly NotEntitledReason[] = Object.values(NotEntitledReason)
    private static readonly Table: ReadonlyMap<CustomerErrorCode, readonly [number, string]> = new Map<CustomerErrorCode, readonly [number, string]>([
        [CustomerErrorCode.InvalidRequest, [400, 'The request is not valid']],
        [CustomerErrorCode.InvalidDomain, [400, 'Not an email domain that can be verified']],
        [CustomerErrorCode.Unauthorized, [401, 'Unauthorized']],
        [CustomerErrorCode.NotSignedIn, [401, 'Not signed in']],
        [CustomerErrorCode.NotAdminOfClient, [403, 'You are not an admin of this client']],
        [CustomerErrorCode.NotEntitled, [403, 'The client is not entitled to this']],
        [CustomerErrorCode.UnknownTenant, [404, 'No such tenant']],
        [CustomerErrorCode.UnknownHive, [404, 'No such hive']],
        [CustomerErrorCode.TenantTaken, [409, 'That tenant id is taken']],
        [CustomerErrorCode.DomainTaken, [409, 'That domain is verified by another tenant']],
        [CustomerErrorCode.Unavailable, [503, 'The platform is unavailable']],
    ])
    private static readonly ReasonOfDecision: ReadonlyMap<EntitlementDecision, NotEntitledReason> = new Map([
        [EntitlementDecision.Suspended, NotEntitledReason.Suspended],
        [EntitlementDecision.NotInPlan, NotEntitledReason.NotInPlan],
        [EntitlementDecision.LimitReached, NotEntitledReason.LimitReached],
    ])

    public static StatusOf(code: CustomerErrorCode): number
    {
        return (CustomerErrorCodes.Table.get(code) as readonly [number, string])[0]
    }

    public static MessageOf(code: CustomerErrorCode): string
    {
        return (CustomerErrorCodes.Table.get(code) as readonly [number, string])[1]
    }

    public static Parse(code: unknown): CustomerErrorCode | undefined
    {
        return CustomerErrorCodes.All.find(known => known === code)
    }

    public static ParseReason(reason: unknown): NotEntitledReason | undefined
    {
        return CustomerErrorCodes.Reasons.find(known => known === reason)
    }

    /** The reason for a refusing decision (undefined for allowed). */
    public static ReasonOf(decision: EntitlementDecision): NotEntitledReason | undefined
    {
        return CustomerErrorCodes.ReasonOfDecision.get(decision)
    }
}

/** A failed customer API call; `not-entitled` carries its reason. Thrown by the platform admin console's service
 *  (answered with its status, code and reason) and by the client (from the answer). */
export class CustomerApiError extends HttpProblem
{
    public static readonly ReasonField = 'reason'
    private static readonly CustomerErrorName = 'CustomerApiError'

    public constructor(public readonly CustomerCode: CustomerErrorCode, public readonly Reason: NotEntitledReason | undefined = undefined)
    {
        super(CustomerErrorCodes.StatusOf(CustomerCode), CustomerErrorCodes.MessageOf(CustomerCode), CustomerCode)
        this.name = CustomerApiError.CustomerErrorName
    }

    public override Fields(): Record<string, unknown>
    {
        const fields = super.Fields()
        if (this.Reason !== undefined)
        {
            fields[CustomerApiError.ReasonField] = this.Reason
        }
        return fields
    }
}
