import { EntitlementDecision } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, EntitledOperation, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerErrorCode, CustomerErrorCodes } from '../errors/customer-api-error.js'

/**
 * The platform admin console's checks before a customer operation, against the client's latest entitlement
 * statement: the caller must be one of its customer admins, and a gated operation must be allowed by the
 * entitlement at the client's current usage. A client the platform holds no statement for answers
 * `not-admin-of-client` like a client the caller does not administer, so the answer reveals no client's existence.
 */
export class CustomerApiGate
{
    /** The statement, when `customer` administers client `clientId`. */
    public static RequireAdmin(clientId: string, statement: EntitlementStatement | undefined, customer: CentralLoginSubject): EntitlementStatement
    {
        if (statement === undefined || statement.ClientId !== clientId || !statement.IsAdmin(customer))
        {
            throw new CustomerApiError(CustomerErrorCode.NotAdminOfClient)
        }
        return statement
    }

    /** RequireAdmin, then the entitlement's decision for `operation` at `currentUsage`. */
    public static RequireEntitled(clientId: string, statement: EntitlementStatement | undefined, customer: CentralLoginSubject, operation: EntitledOperation, currentUsage: number): EntitlementStatement
    {
        const admitted = CustomerApiGate.RequireAdmin(clientId, statement, customer)
        const decision = admitted.Entitlement.Decide(operation, currentUsage)
        if (decision !== EntitlementDecision.Allowed)
        {
            throw new CustomerApiError(CustomerErrorCode.NotEntitled, CustomerErrorCodes.ReasonOf(decision))
        }
        return admitted
    }
}
