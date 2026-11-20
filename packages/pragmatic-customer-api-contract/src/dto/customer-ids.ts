import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKinds } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

/** The id shapes the customer API carries, and the member every request starts with. */
export class CustomerIds
{
    /** A tenant id: used in host names, so lowercase letters, digits and inner `-`, 3-32 characters, starting with a
     *  letter. */
    public static readonly TenantIdPattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/
    public static readonly HiveIdPattern = ClientKinds.IdPattern
    public static readonly ClientIdField = 'ClientId'
    public static readonly TenantIdField = 'TenantId'
    public static readonly HiveIdField = 'HiveId'
    public static readonly DomainField = 'Domain'
    public static readonly LevelField = 'Level'
    public static readonly DisplayNameField = 'DisplayName'
    public static readonly StateField = 'State'
    public static readonly MaxDisplayName = 200

    public static ClientId(fields: JsonFields): string
    {
        return fields.String(CustomerIds.ClientIdField, { Pattern: ClientKinds.IdPattern })
    }
}
