import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import type { SignedEnvelope } from '../envelope/signed-envelope.js'
import type { VerifiedMessage } from '../envelope/envelope-verifier.js'
import type { Intent } from './intent.js'

/** A customer's answer to an Enrolled intent. */
export enum IntentDecisionKind
{
    Approved = 'approved',
    Rejected = 'rejected',
}

export interface RealmSubjectJson
{
    Realm: string
    Subject: string
}

/** A person in a realm: the realm id and the subject its sign-in issued. Never a name or an email. */
export class RealmSubject
{
    private static readonly Field = { Realm: 'Realm', Subject: 'Subject' } as const
    private static readonly Members: readonly string[] = Object.values(RealmSubject.Field)

    private constructor(public readonly Realm: string, public readonly Subject: string)
    {
    }

    public static Of(realm: string, subject: string): RealmSubject
    {
        return RealmSubject.Parse({ Realm: realm, Subject: subject })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): RealmSubject
    {
        const F = RealmSubject.Field
        const fields = StrictFields.Exactly(value, RealmSubject.Members, path)
        return new RealmSubject(fields.String(F.Realm, { Max: 63, Pattern: ProtocolNames.Label }), fields.String(F.Subject, { Max: 255, Pattern: ProtocolNames.Subject }))
    }

    public ToJson(): RealmSubjectJson
    {
        return { Realm: this.Realm, Subject: this.Subject }
    }
}

export interface IntentDecisionJson
{
    IntentId: string
    IntentDigest: string
    Decision: IntentDecisionKind
    Approver: RealmSubjectJson
    DecidedAt: string
}

/**
 * The approval or rejection of one intent (`MessageKind.IntentDecision`, signed by the hive key). It names the intent
 * by id and by the digest of the exact signed intent it answers, so it cannot be moved onto another or a reissued one;
 * the approver is the realm subject who decided in the tenant admin console. A rejection carries no reason text.
 */
export class IntentDecision
{
    public static readonly Decisions: readonly IntentDecisionKind[] = Object.values(IntentDecisionKind)
    private static readonly Field = { IntentId: 'IntentId', IntentDigest: 'IntentDigest', Decision: 'Decision', Approver: 'Approver', DecidedAt: 'DecidedAt' } as const
    private static readonly Members: readonly string[] = Object.values(IntentDecision.Field)

    private constructor(
        public readonly IntentId: string,
        public readonly IntentDigest: string,
        public readonly Decision: IntentDecisionKind,
        public readonly Approver: RealmSubject,
        public readonly DecidedAt: Date)
    {
    }

    /** The decision on a verified intent. */
    public static For(intent: VerifiedMessage<Intent>, decision: IntentDecisionKind, approver: RealmSubject, decidedAt: Date): IntentDecision
    {
        return IntentDecision.Parse({ IntentId: intent.Body.IntentId, IntentDigest: intent.Digest, Decision: decision, Approver: approver.ToJson(), DecidedAt: decidedAt.toISOString() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): IntentDecision
    {
        const F = IntentDecision.Field
        const fields = StrictFields.Exactly(value, IntentDecision.Members, path)
        return new IntentDecision(
            fields.String(F.IntentId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.String(F.IntentDigest, { Pattern: ProtocolNames.Digest }),
            fields.Enum(F.Decision, IntentDecision.Decisions),
            fields.Read(F.Approver, (raw, at) => RealmSubject.Parse(raw, at)),
            fields.Timestamp(F.DecidedAt))
    }

    /** Whether this decision answers exactly `intent` (the signed intent the platform issued). */
    public Answers(intent: SignedEnvelope, body: Intent): boolean
    {
        return this.IntentId === body.IntentId && this.IntentDigest === intent.Digest
    }

    public ToJson(): IntentDecisionJson
    {
        return { IntentId: this.IntentId, IntentDigest: this.IntentDigest, Decision: this.Decision, Approver: this.Approver.ToJson(), DecidedAt: this.DecidedAt.toISOString() }
    }
}
