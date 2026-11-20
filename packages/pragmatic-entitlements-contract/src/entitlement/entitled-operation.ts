/** The named limits a plan may carry. Other names are allowed on the wire (a newer ledger), but gate nothing here. */
export enum EntitlementLimit
{
    Tenants = 'tenants',
    Hives = 'hives',
    VerifiedDomains = 'verified-domains',
}

/** The customer operations an entitlement gates. Reads and leaving are never gated (only "admin of the client"). */
export enum EntitledOperation
{
    CreateTenant = 'create-tenant',
    EnrolHive = 'enrol-hive',
    VerifyEmailDomain = 'verify-email-domain',
}

/** Which limit each gated operation consumes. */
export class EntitledOperations
{
    public static readonly All: readonly EntitledOperation[] = Object.values(EntitledOperation)
    private static readonly Limits: ReadonlyMap<EntitledOperation, EntitlementLimit> = new Map([
        [EntitledOperation.CreateTenant, EntitlementLimit.Tenants],
        [EntitledOperation.EnrolHive, EntitlementLimit.Hives],
        [EntitledOperation.VerifyEmailDomain, EntitlementLimit.VerifiedDomains],
    ])

    public static LimitOf(operation: EntitledOperation): EntitlementLimit
    {
        return EntitledOperations.Limits.get(operation) as EntitlementLimit
    }
}
