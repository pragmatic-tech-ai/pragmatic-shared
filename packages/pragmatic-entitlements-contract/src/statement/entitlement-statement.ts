import { BadRequestProblem, JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientKind, ClientKinds } from '../client/client-kind.js'
import { CentralLoginSubject } from '../central-login/central-login-subject.js'
import type { CentralLoginSubjectJson } from '../central-login/central-login-subject.js'
import { Entitlement, EntitlementLimits, EntitlementState } from '../entitlement/entitlement.js'

/** The wire form of a statement (schema 1). */
export interface EntitlementStatementJson
{
    Schema: number
    ClientId: string
    ClientKind: ClientKind
    ClientName: string
    Admins: CentralLoginSubjectJson[]
    PlanId: string
    Limits: Record<string, number>
    State: EntitlementState
    Version: number
    IssuedAt: string
}

/** What a statement says, before it is checked. */
export interface EntitlementStatementOptions
{
    ClientId: string
    ClientKind: ClientKind
    ClientName: string
    Admins: readonly CentralLoginSubject[]
    PlanId: string
    Limits: EntitlementLimits
    State: EntitlementState
    Version: number
    IssuedAt: Date
}

/**
 * What the clients ledger states about one client: its kind and name, its customer admins (central-login subjects),
 * its plan's limits and whether it is active. Never a price, a payment or an order to act. `Version` grows by at
 * least one with every statement the ledger issues for the client, so the receiver keeps the newest and ignores the
 * rest; `IssuedAt` says when, for people reading the record.
 */
export class EntitlementStatement
{
    public static readonly Schema = 1
    public static readonly MaxAdmins = 50
    private static readonly SchemaField = 'Schema'
    private static readonly ClientIdField = 'ClientId'
    private static readonly ClientKindField = 'ClientKind'
    private static readonly ClientNameField = 'ClientName'
    private static readonly AdminsField = 'Admins'
    private static readonly PlanIdField = 'PlanId'
    private static readonly StateField = 'State'
    private static readonly VersionField = 'Version'
    private static readonly IssuedAtField = 'IssuedAt'
    private static readonly Members = [EntitlementStatement.SchemaField, EntitlementStatement.ClientIdField, EntitlementStatement.ClientKindField, EntitlementStatement.ClientNameField, EntitlementStatement.AdminsField, EntitlementStatement.PlanIdField, EntitlementLimits.Field, EntitlementStatement.StateField, EntitlementStatement.VersionField, EntitlementStatement.IssuedAtField]
    private static readonly States: readonly EntitlementState[] = Object.values(EntitlementState)
    private static readonly NoAdminMessage = 'body.Admins: at least one customer admin is required'
    private static readonly DuplicateAdminMessage = 'body.Admins: the same subject is listed twice'

    private constructor(
        public readonly ClientId: string,
        public readonly ClientKind: ClientKind,
        public readonly ClientName: string,
        public readonly Admins: readonly CentralLoginSubject[],
        public readonly PlanId: string,
        public readonly Limits: EntitlementLimits,
        public readonly State: EntitlementState,
        public readonly Version: number,
        public readonly IssuedAt: Date)
    {
    }

    /** A checked statement (the same rules as Parse). */
    public static Create(options: EntitlementStatementOptions): EntitlementStatement
    {
        return EntitlementStatement.Parse({
            Schema: EntitlementStatement.Schema,
            ClientId: options.ClientId,
            ClientKind: options.ClientKind,
            ClientName: options.ClientName,
            Admins: options.Admins.map(admin => admin.ToJson()),
            PlanId: options.PlanId,
            Limits: options.Limits.ToJson(),
            State: options.State,
            Version: options.Version,
            IssuedAt: options.IssuedAt.toISOString(),
        })
    }

    /** Strict decoding: unknown members, another schema, or any malformed member is a BadRequestProblem. */
    public static Parse(value: unknown): EntitlementStatement
    {
        const S = EntitlementStatement
        const fields = JsonFields.Of(value).OnlyKnown(S.Members)
        fields.Integer(S.SchemaField, { Min: S.Schema, Max: S.Schema })
        const admins = fields.Array(S.AdminsField, S.MaxAdmins, (entry, path) => CentralLoginSubject.Parse(entry, path))
        if (admins.length === 0)
        {
            throw new BadRequestProblem(S.NoAdminMessage)
        }
        if (new Set(admins.map(admin => admin.Key)).size !== admins.length)
        {
            throw new BadRequestProblem(S.DuplicateAdminMessage)
        }
        return new EntitlementStatement(
            fields.String(S.ClientIdField, { Pattern: ClientKinds.IdPattern }),
            fields.Enum(S.ClientKindField, ClientKinds.All),
            fields.String(S.ClientNameField, { Max: ClientKinds.MaxNameLength }),
            admins,
            fields.String(S.PlanIdField, { Pattern: ClientKinds.IdPattern }),
            EntitlementLimits.Read(fields),
            fields.Enum(S.StateField, S.States),
            fields.Integer(S.VersionField, { Min: 1 }),
            fields.Timestamp(S.IssuedAtField))
    }

    public get Entitlement(): Entitlement
    {
        return new Entitlement(this.State, this.Limits)
    }

    /** Whether `subject` is one of the client's customer admins. */
    public IsAdmin(subject: CentralLoginSubject): boolean
    {
        return this.Admins.some(admin => admin.Same(subject))
    }

    public ToJson(): EntitlementStatementJson
    {
        return {
            Schema: EntitlementStatement.Schema,
            ClientId: this.ClientId,
            ClientKind: this.ClientKind,
            ClientName: this.ClientName,
            Admins: this.Admins.map(admin => admin.ToJson()),
            PlanId: this.PlanId,
            Limits: this.Limits.ToJson(),
            State: this.State,
            Version: this.Version,
            IssuedAt: this.IssuedAt.toISOString(),
        }
    }
}
