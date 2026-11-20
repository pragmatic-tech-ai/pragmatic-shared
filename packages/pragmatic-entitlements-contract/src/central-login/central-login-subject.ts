import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The wire form of a central-login subject. */
export interface CentralLoginSubjectJson
{
    Issuer: string
    Subject: string
    Email: string
}

/**
 * A customer admin's account in the central login: the issuer and the subject identify it; the email is informational
 * (it can change and is never compared for identity).
 */
export class CentralLoginSubject
{
    public static readonly IssuerField = 'Issuer'
    public static readonly SubjectField = 'Subject'
    public static readonly EmailField = 'Email'
    private static readonly Fields = [CentralLoginSubject.IssuerField, CentralLoginSubject.SubjectField, CentralLoginSubject.EmailField]
    private static readonly IssuerPattern = /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/
    private static readonly EmailPattern = /^[^\s@]+@[^\s@]+$/
    private static readonly MaxIssuer = 512
    private static readonly MaxSubject = 255
    private static readonly MaxEmail = 254
    private static readonly KeySeparator = '\n'

    private constructor(public readonly Issuer: string, public readonly Subject: string, public readonly Email: string)
    {
    }

    /** A checked subject (throws BadRequestProblem for one that is not well formed). */
    public static Of(issuer: string, subject: string, email: string): CentralLoginSubject
    {
        return CentralLoginSubject.Parse({ Issuer: issuer, Subject: subject, Email: email })
    }

    public static Parse(value: unknown, path?: string): CentralLoginSubject
    {
        const fields = JsonFields.Of(value, path).OnlyKnown(CentralLoginSubject.Fields)
        return new CentralLoginSubject(
            fields.String(CentralLoginSubject.IssuerField, { Max: CentralLoginSubject.MaxIssuer, Pattern: CentralLoginSubject.IssuerPattern }),
            fields.String(CentralLoginSubject.SubjectField, { Max: CentralLoginSubject.MaxSubject }),
            fields.String(CentralLoginSubject.EmailField, { Max: CentralLoginSubject.MaxEmail, Pattern: CentralLoginSubject.EmailPattern }))
    }

    /** The same account: issuer and subject equal. */
    public Same(other: CentralLoginSubject): boolean
    {
        return this.Issuer === other.Issuer && this.Subject === other.Subject
    }

    /** A key that is equal exactly when Same is true. */
    public get Key(): string
    {
        return this.Issuer + CentralLoginSubject.KeySeparator + this.Subject
    }

    public ToJson(): CentralLoginSubjectJson
    {
        return { Issuer: this.Issuer, Subject: this.Subject, Email: this.Email }
    }
}
