import type { EntitlementStatement } from '../statement/entitlement-statement.js'

/**
 * Where the platform admin console keeps the statements it accepts (its operational client record is derived from
 * them). The receiver serialises calls per client within one process; a sink shared by several processes must make
 * Apply conditional on the version itself.
 */
export interface IEntitlementSink
{
    /** The version of the client's statement held now, or undefined when none. */
    CurrentVersion(clientId: string): Promise<number | undefined>
    /** Keeps a statement newer than the current one. */
    Apply(statement: EntitlementStatement): Promise<void>
}
