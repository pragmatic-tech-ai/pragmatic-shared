import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CentralLoginSubject, ClientKind, ClientKinds } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubjectJson } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { SubscriptionView } from './subscription.js'
import type { SubscriptionViewJson } from './subscription.js'

/** `register-client`: the client's kind and name and the campaign or invitation code it came with. The first admin
 *  is the verified caller, never a member of the request. */
export class RegisterClientRequest
{
    public static readonly CodePattern = /^[A-Za-z0-9-]{1,64}$/
    private static readonly Field = { Kind: 'Kind', Name: 'Name', Code: 'Code' } as const
    private static readonly Members: readonly string[] = Object.values(RegisterClientRequest.Field)

    public constructor(public readonly Kind: ClientKind, public readonly Name: string, public readonly Code: string | null = null)
    {
    }

    public static Parse(value: unknown): RegisterClientRequest
    {
        const F = RegisterClientRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(RegisterClientRequest.Members)
        return new RegisterClientRequest(
            fields.Enum(F.Kind, ClientKinds.All),
            fields.String(F.Name, { Max: ClientKinds.MaxNameLength }),
            fields.NullableString(F.Code, { Pattern: RegisterClientRequest.CodePattern }))
    }

    public ToJson(): { Kind: ClientKind, Name: string, Code: string | null }
    {
        return { Kind: this.Kind, Name: this.Name, Code: this.Code }
    }
}

export interface ClientViewJson
{
    ClientId: string
    Kind: ClientKind
    Name: string
    Admins: CentralLoginSubjectJson[]
    Subscription: SubscriptionViewJson | null
}

/** The customer's view of their client: id, kind, name, customer admins and the subscription (null before one). */
export class ClientView
{
    public static readonly MaxAdmins = 50
    private static readonly Field = { ClientId: 'ClientId', Kind: 'Kind', Name: 'Name', Admins: 'Admins', Subscription: 'Subscription' } as const
    private static readonly Members: readonly string[] = Object.values(ClientView.Field)

    public constructor(
        public readonly ClientId: string,
        public readonly Kind: ClientKind,
        public readonly Name: string,
        public readonly Admins: readonly CentralLoginSubject[],
        public readonly Subscription: SubscriptionView | null)
    {
    }

    public static Parse(value: unknown, path?: string): ClientView
    {
        const F = ClientView.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(ClientView.Members)
        return new ClientView(
            fields.String(F.ClientId, { Pattern: ClientKinds.IdPattern }),
            fields.Enum(F.Kind, ClientKinds.All),
            fields.String(F.Name, { Max: ClientKinds.MaxNameLength }),
            fields.Array(F.Admins, ClientView.MaxAdmins, (entry, at) => CentralLoginSubject.Parse(entry, at)),
            fields.NullableRead(F.Subscription, (entry, at) => SubscriptionView.Parse(entry, at)))
    }

    public ToJson(): ClientViewJson
    {
        return {
            ClientId: this.ClientId,
            Kind: this.Kind,
            Name: this.Name,
            Admins: this.Admins.map(admin => admin.ToJson()),
            Subscription: this.Subscription?.ToJson() ?? null,
        }
    }
}

/** `my-client`: the caller's client, or null when the caller administers none yet (they register next). */
export class MyClientReply
{
    private static readonly ClientField = 'Client'
    private static readonly Members: readonly string[] = [MyClientReply.ClientField]

    public constructor(public readonly Client: ClientView | null)
    {
    }

    public static Parse(value: unknown): MyClientReply
    {
        const fields = JsonFields.Of(value).OnlyKnown(MyClientReply.Members)
        return new MyClientReply(fields.NullableRead(MyClientReply.ClientField, (entry, at) => ClientView.Parse(entry, at)))
    }

    public ToJson(): { Client: ClientViewJson | null }
    {
        return { Client: this.Client?.ToJson() ?? null }
    }
}
