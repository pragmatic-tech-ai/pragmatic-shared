/** Ends a tenant principal's, or a whole tenant's, tenant-plane sessions (host-free: no tenant-plane types). */
export interface IOwnerSessionRevoker
{
    RevokeAllFor(tenantId: string, principalId: string): Promise<void>;

    /** Ends every session of the tenant, console and desktop, and closes its open connections. */
    RevokeTenant(tenantId: string): Promise<void>;
}
