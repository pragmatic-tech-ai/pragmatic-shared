import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKinds } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerIds } from './customer-ids.js'

/** `create-tenant`: a tenant record under the client (creating a tenant is only a record). */
export class CreateTenantRequest
{
    private static readonly Field = { ClientId: CustomerIds.ClientIdField, TenantId: CustomerIds.TenantIdField, DisplayName: CustomerIds.DisplayNameField } as const
    private static readonly Members: readonly string[] = Object.values(CreateTenantRequest.Field)

    public constructor(public readonly ClientId: string, public readonly TenantId: string, public readonly DisplayName: string)
    {
    }

    public static Parse(value: unknown): CreateTenantRequest
    {
        const F = CreateTenantRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(CreateTenantRequest.Members)
        return new CreateTenantRequest(CustomerIds.ClientId(fields), fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }), fields.String(F.DisplayName, { Max: CustomerIds.MaxDisplayName }))
    }

    public ToJson(): { ClientId: string, TenantId: string, DisplayName: string }
    {
        return { ClientId: this.ClientId, TenantId: this.TenantId, DisplayName: this.DisplayName }
    }
}

/** `list-tenants`: the client's tenants. */
export class ListTenantsRequest
{
    private static readonly Members: readonly string[] = [CustomerIds.ClientIdField]

    public constructor(public readonly ClientId: string)
    {
    }

    public static Parse(value: unknown): ListTenantsRequest
    {
        return new ListTenantsRequest(CustomerIds.ClientId(JsonFields.Of(value).OnlyKnown(ListTenantsRequest.Members)))
    }

    public ToJson(): { ClientId: string }
    {
        return { ClientId: this.ClientId }
    }
}

export interface TenantViewJson
{
    TenantId: string
    ClientId: string
    DisplayName: string
    CreatedAt: string
}

/** A tenant as its customer admin sees it. */
export class TenantView
{
    private static readonly Field = { TenantId: CustomerIds.TenantIdField, ClientId: CustomerIds.ClientIdField, DisplayName: CustomerIds.DisplayNameField, CreatedAt: 'CreatedAt' } as const
    private static readonly Members: readonly string[] = Object.values(TenantView.Field)

    public constructor(public readonly TenantId: string, public readonly ClientId: string, public readonly DisplayName: string, public readonly CreatedAt: Date)
    {
    }

    public static Parse(value: unknown, path?: string): TenantView
    {
        const F = TenantView.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(TenantView.Members)
        return new TenantView(
            fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }),
            fields.String(F.ClientId, { Pattern: ClientKinds.IdPattern }),
            fields.String(F.DisplayName, { Max: CustomerIds.MaxDisplayName }),
            fields.Timestamp(F.CreatedAt))
    }

    public ToJson(): TenantViewJson
    {
        return { TenantId: this.TenantId, ClientId: this.ClientId, DisplayName: this.DisplayName, CreatedAt: this.CreatedAt.toISOString() }
    }
}

/** `list-tenants` answer. */
export class TenantList
{
    public static readonly MaxTenants = 1000
    private static readonly TenantsField = 'Tenants'
    private static readonly Members: readonly string[] = [TenantList.TenantsField]

    public constructor(public readonly Tenants: readonly TenantView[])
    {
    }

    public static Parse(value: unknown): TenantList
    {
        const fields = JsonFields.Of(value).OnlyKnown(TenantList.Members)
        return new TenantList(fields.Array(TenantList.TenantsField, TenantList.MaxTenants, (entry, path) => TenantView.Parse(entry, path)))
    }

    public ToJson(): { Tenants: TenantViewJson[] }
    {
        return { Tenants: this.Tenants.map(tenant => tenant.ToJson()) }
    }
}
