import type { IdpConnection } from './idp-workload-driver.js'

export interface IIdpService
{
    EnsureForTenant(tenantId: string, displayName: string): Promise<IdpConnection>

    /** Non-creating lookup: a connection to the tenant's existing IdP, or undefined when there is NO record (never creates a record for an absent tenant). A record that exists but is stopped may be relaunched (and a port allocated) to serve the connection. */
    ConnectForTenant(tenantId: string): Promise<IdpConnection | undefined>

    /** Discards the tenant's per-tenant IdP and forgets its record; a tenant with no IdP record is a safe no-op. */
    TeardownForTenant(tenantId: string): Promise<void>
}
