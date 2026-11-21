import type { HiveRecord, TenantRecord } from '../platform-records.js'

/**
 * The narrow platform-directory read seam the tenant plane depends on: only what it reads, nothing it could mutate.
 * `PlatformDirectory` satisfies it structurally; a tenant-local implementation can supply the same reads.
 */
export interface ITenantDirectory
{
    GetTenant(id: string): TenantRecord | undefined
    GetHive(id: string): HiveRecord | undefined
    ListHives(tenantId: string): readonly HiveRecord[]
    /** The tenant's organisation name, when the directory knows it (optional: the platform directory does not carry one). */
    GetOrganisation?(tenantId: string): string | undefined
}

/** One tenant, its hives and its organisation: what a tenant-local directory is seeded with (the tenant console's startup config). */
export type TenantDirectorySeed = {
    readonly tenant: TenantRecord
    readonly hives: readonly HiveRecord[]
    readonly organisation?: string
}
