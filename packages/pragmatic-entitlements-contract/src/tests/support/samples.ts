import { CentralLoginSubject } from '../../central-login/central-login-subject.js'
import { ClientKind } from '../../client/client-kind.js'
import { EntitlementLimits, EntitlementState } from '../../entitlement/entitlement.js'
import { EntitlementStatement } from '../../statement/entitlement-statement.js'
import type { EntitlementStatementJson } from '../../statement/entitlement-statement.js'

/** Sample statements and subjects. */
export class Samples
{
    public static readonly Issuer = 'https://securetoken.google.com/pragmatic-identity'
    public static readonly Admin = CentralLoginSubject.Of(Samples.Issuer, 'u1', 'a@acme.com')
    public static readonly Other = CentralLoginSubject.Of(Samples.Issuer, 'u2', 'b@acme.com')

    public static Json(overrides: Partial<Record<keyof EntitlementStatementJson, unknown>> = {}): Record<string, unknown>
    {
        return {
            Schema: 1,
            ClientId: 'acme',
            ClientKind: 'organisation',
            ClientName: 'Acme Ltd',
            Admins: [Samples.Admin.ToJson()],
            PlanId: 'team',
            Limits: { 'tenants': 1, 'hives': 3, 'verified-domains': 5 },
            State: 'active',
            Version: 7,
            IssuedAt: '2026-11-20T10:00:00.000Z',
            ...overrides,
        }
    }

    public static Statement(version: number, clientId = 'acme', state = EntitlementState.Active): EntitlementStatement
    {
        return EntitlementStatement.Create({
            ClientId: clientId,
            ClientKind: ClientKind.Organisation,
            ClientName: 'Acme Ltd',
            Admins: [Samples.Admin],
            PlanId: 'team',
            Limits: EntitlementLimits.Of({ tenants: 1, hives: 3 }),
            State: state,
            Version: version,
            IssuedAt: new Date('2026-11-20T10:00:00.000Z'),
        })
    }
}
