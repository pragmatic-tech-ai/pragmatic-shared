import { HttpProblem } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The codes a ledger API call can fail with. `unavailable` is only ever raised by the client (no answer). */
export enum LedgerErrorCode
{
    InvalidRequest = 'invalid-request',
    InvalidCode = 'invalid-code',
    Unauthorized = 'unauthorized',
    NotSignedIn = 'not-signed-in',
    NoClient = 'no-client',
    UnknownPlan = 'unknown-plan',
    NoSubscription = 'no-subscription',
    AlreadyRegistered = 'already-registered',
    AlreadySubscribed = 'already-subscribed',
    PlanNotPurchasable = 'plan-not-purchasable',
    Unavailable = 'unavailable',
}

/** Each code's status and fixed message (never a value from the request). */
export class LedgerErrorCodes
{
    public static readonly All: readonly LedgerErrorCode[] = Object.values(LedgerErrorCode)
    private static readonly Table: ReadonlyMap<LedgerErrorCode, readonly [number, string]> = new Map<LedgerErrorCode, readonly [number, string]>([
        [LedgerErrorCode.InvalidRequest, [400, 'The request is not valid']],
        [LedgerErrorCode.InvalidCode, [400, 'The campaign or invitation code is not valid']],
        [LedgerErrorCode.Unauthorized, [401, 'Unauthorized']],
        [LedgerErrorCode.NotSignedIn, [401, 'Not signed in']],
        [LedgerErrorCode.NoClient, [404, 'No client is registered for this account']],
        [LedgerErrorCode.UnknownPlan, [404, 'No such plan']],
        [LedgerErrorCode.NoSubscription, [404, 'There is no subscription']],
        [LedgerErrorCode.AlreadyRegistered, [409, 'This account already administers a client']],
        [LedgerErrorCode.AlreadySubscribed, [409, 'The client already has a subscription']],
        [LedgerErrorCode.PlanNotPurchasable, [422, 'This plan cannot be bought']],
        [LedgerErrorCode.Unavailable, [503, 'The ledger is unavailable']],
    ])

    public static StatusOf(code: LedgerErrorCode): number
    {
        return (LedgerErrorCodes.Table.get(code) as readonly [number, string])[0]
    }

    public static MessageOf(code: LedgerErrorCode): string
    {
        return (LedgerErrorCodes.Table.get(code) as readonly [number, string])[1]
    }

    public static Parse(code: unknown): LedgerErrorCode | undefined
    {
        return LedgerErrorCodes.All.find(known => known === code)
    }
}

/** A failed ledger API call. Thrown by the ledger's service (the routes answer it with its status and code) and by
 *  the client (from the answer's code). */
export class LedgerApiError extends HttpProblem
{
    private static readonly LedgerErrorName = 'LedgerApiError'

    public constructor(public readonly LedgerCode: LedgerErrorCode)
    {
        super(LedgerErrorCodes.StatusOf(LedgerCode), LedgerErrorCodes.MessageOf(LedgerCode), LedgerCode)
        this.name = LedgerApiError.LedgerErrorName
    }
}
