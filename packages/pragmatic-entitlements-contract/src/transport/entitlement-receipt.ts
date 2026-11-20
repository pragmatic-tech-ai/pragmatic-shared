import { JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'

/** What the receiver did with a statement. Every outcome is final: the sender stops resending it. */
export enum ReceiptOutcome
{
    /** Newer than what the receiver had: handed to the sink. */
    Applied = 'applied',
    /** The receiver already has this version. */
    Duplicate = 'duplicate',
    /** The receiver already has a newer version. */
    Stale = 'stale',
}

export interface EntitlementReceiptJson
{
    Outcome: ReceiptOutcome
    CurrentVersion: number
}

/** The receiver's answer to one statement: the outcome and the version it now holds for the client. */
export class EntitlementReceipt
{
    private static readonly OutcomeField = 'Outcome'
    private static readonly VersionField = 'CurrentVersion'
    private static readonly Members = [EntitlementReceipt.OutcomeField, EntitlementReceipt.VersionField]
    private static readonly Outcomes: readonly ReceiptOutcome[] = Object.values(ReceiptOutcome)

    public constructor(public readonly Outcome: ReceiptOutcome, public readonly CurrentVersion: number)
    {
    }

    public static Parse(value: unknown): EntitlementReceipt
    {
        const fields = JsonFields.Of(value).OnlyKnown(EntitlementReceipt.Members)
        return new EntitlementReceipt(fields.Enum(EntitlementReceipt.OutcomeField, EntitlementReceipt.Outcomes), fields.Integer(EntitlementReceipt.VersionField, { Min: 1 }))
    }

    public ToJson(): EntitlementReceiptJson
    {
        return { Outcome: this.Outcome, CurrentVersion: this.CurrentVersion }
    }
}
