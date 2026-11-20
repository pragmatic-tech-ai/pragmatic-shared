import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerApiError, CustomerErrorCode } from '../errors/customer-api-error.js'
import { CustomerIds } from './customer-ids.js'

/** Where proving a domain stands. */
export enum DomainVerificationState
{
    Pending = 'pending',
    Verified = 'verified',
    Failed = 'failed',
}

/** The DNS record type the proof is published as. */
export enum DomainRecordType
{
    Txt = 'TXT',
}

/** A verifiable email domain: lowercase, at least two labels, a letters-only top-level label. */
export class EmailDomain
{
    private static readonly Pattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

    public static IsValid(domain: string): boolean
    {
        return EmailDomain.Pattern.test(domain)
    }
}

/** `start-domain-verification` and `check-domain-verification`: an email domain of the tenant. A domain that is not
 *  a verifiable domain is `invalid-domain`. */
export class DomainVerificationRequest
{
    private static readonly Field = { ClientId: CustomerIds.ClientIdField, TenantId: CustomerIds.TenantIdField, Domain: CustomerIds.DomainField } as const
    private static readonly Members: readonly string[] = Object.values(DomainVerificationRequest.Field)
    private static readonly MaxDomain = 253

    public constructor(public readonly ClientId: string, public readonly TenantId: string, public readonly Domain: string)
    {
    }

    public static Parse(value: unknown): DomainVerificationRequest
    {
        const F = DomainVerificationRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(DomainVerificationRequest.Members)
        const request = new DomainVerificationRequest(CustomerIds.ClientId(fields), fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }), fields.String(F.Domain, { Max: DomainVerificationRequest.MaxDomain }))
        if (!EmailDomain.IsValid(request.Domain))
        {
            throw new CustomerApiError(CustomerErrorCode.InvalidDomain)
        }
        return request
    }

    public ToJson(): { ClientId: string, TenantId: string, Domain: string }
    {
        return { ClientId: this.ClientId, TenantId: this.TenantId, Domain: this.Domain }
    }
}

export interface DomainVerificationJson
{
    TenantId: string
    Domain: string
    State: DomainVerificationState
    RecordType: DomainRecordType
    RecordName: string
    RecordValue: string
}

/** The proof to publish (a TXT record) and where the verification stands. */
export class DomainVerification
{
    public static readonly MaxRecord = 512
    private static readonly Field = { TenantId: CustomerIds.TenantIdField, Domain: CustomerIds.DomainField, State: CustomerIds.StateField, RecordType: 'RecordType', RecordName: 'RecordName', RecordValue: 'RecordValue' } as const
    private static readonly Members: readonly string[] = Object.values(DomainVerification.Field)
    private static readonly States: readonly DomainVerificationState[] = Object.values(DomainVerificationState)
    private static readonly RecordTypes: readonly DomainRecordType[] = Object.values(DomainRecordType)

    public constructor(
        public readonly TenantId: string,
        public readonly Domain: string,
        public readonly State: DomainVerificationState,
        public readonly RecordName: string,
        public readonly RecordValue: string,
        public readonly RecordType: DomainRecordType = DomainRecordType.Txt)
    {
    }

    public static Parse(value: unknown): DomainVerification
    {
        const F = DomainVerification.Field
        const fields = JsonFields.Of(value).OnlyKnown(DomainVerification.Members)
        const record = fields.Enum(F.RecordType, DomainVerification.RecordTypes)
        return new DomainVerification(
            fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }),
            fields.String(F.Domain, { Max: DomainVerification.MaxRecord }),
            fields.Enum(F.State, DomainVerification.States),
            fields.String(F.RecordName, { Max: DomainVerification.MaxRecord }),
            fields.String(F.RecordValue, { Max: DomainVerification.MaxRecord }),
            record)
    }

    public ToJson(): DomainVerificationJson
    {
        return { TenantId: this.TenantId, Domain: this.Domain, State: this.State, RecordType: this.RecordType, RecordName: this.RecordName, RecordValue: this.RecordValue }
    }
}
