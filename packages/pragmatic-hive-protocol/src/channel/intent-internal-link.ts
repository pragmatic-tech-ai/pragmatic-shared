import { HiveLevel, HiveLevels } from '../hive/hive-level.js'
import { IntentActionKind, IntentActions, RepairScope, RotationSubject, type IntentAction } from '../intent/intent-action.js'
import { RealmSubject, type RealmSubjectJson } from '../intent/intent-decision.js'
import { IntentFailure, IntentProgress, IntentStatus } from '../report/hive-report.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/** Why the hive agent did not take the console's decision on a kept intent (C3.4). */
export enum IntentDecisionRefusal
{
    /** The request is not `{ IntentDigest, Decision, Approver }`. */
    Malformed = 'malformed',
    /** The caller is not the engine's console. */
    NotConsole = 'not-console',
    /** The hive is not enrolled, so it keeps no intents. */
    NotEnrolled = 'not-enrolled',
    /** No kept intent has that id. */
    UnknownIntent = 'unknown-intent',
    /** The intent is not waiting for a decision (applied, rejected, failed or applying). */
    NotAwaiting = 'not-awaiting',
    /** The intent expired; the platform may reissue it. */
    Expired = 'expired',
    /** The kept intent is not the one the console showed (another digest: a reissue). */
    DigestMismatch = 'digest-mismatch',
    /** The platform could not be told, or applying could not start; try again. */
    Unavailable = 'unavailable',
}

/** The console's choice on an intent awaiting approval. */
export enum IntentChoice
{
    Approve = 'approve',
    Reject = 'reject',
}

/**
 * `POST /internal/intents/<id>/decision` from the console: the digest of the intent it showed, the choice, and the
 * realm subject of the signed-in admin who chose. A rejection carries no reason.
 */
export class IntentDecisionCall
{
    public static readonly Choices: readonly IntentChoice[] = Object.values(IntentChoice)
    private static readonly Field = { IntentDigest: 'IntentDigest', Decision: 'Decision', Approver: 'Approver' } as const
    private static readonly Members: readonly string[] = Object.values(IntentDecisionCall.Field)

    private constructor(public readonly IntentDigest: string, public readonly Decision: IntentChoice, public readonly Approver: RealmSubject)
    {
    }

    public static Create(intentDigest: string, decision: IntentChoice, approver: RealmSubject): IntentDecisionCall
    {
        return IntentDecisionCall.Parse({ IntentDigest: intentDigest, Decision: decision, Approver: approver.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): IntentDecisionCall
    {
        const F = IntentDecisionCall.Field
        const fields = StrictFields.Exactly(value, IntentDecisionCall.Members, path)
        return new IntentDecisionCall(
            fields.String(F.IntentDigest, { Pattern: ProtocolNames.Digest }),
            fields.Enum(F.Decision, IntentDecisionCall.Choices),
            fields.Read(F.Approver, (raw, at) => RealmSubject.Parse(raw, at)))
    }

    public ToJson(): { IntentDigest: string, Decision: IntentChoice, Approver: RealmSubjectJson }
    {
        return { IntentDigest: this.IntentDigest, Decision: this.Decision, Approver: this.Approver.ToJson() }
    }
}

export interface KeptIntentViewJson
{
    IntentId: string
    IntentDigest: string
    Level: HiveLevel
    Action: Record<string, unknown>
    IssuedAt: string
    ExpiresAt: string
    Progress: IntentProgress
    Failure: IntentFailure | null
}

/** One intent the agent keeps, as the console shows it: what it asks, when it expires, where it stands. */
export class KeptIntentView
{
    private static readonly Field = {
        IntentId: 'IntentId', IntentDigest: 'IntentDigest', Level: 'Level', Action: 'Action', IssuedAt: 'IssuedAt', ExpiresAt: 'ExpiresAt', Progress: 'Progress', Failure: 'Failure',
    } as const
    private static readonly Members: readonly string[] = Object.values(KeptIntentView.Field)

    private constructor(
        public readonly IntentId: string,
        public readonly IntentDigest: string,
        public readonly Level: HiveLevel,
        public readonly Action: IntentAction,
        public readonly IssuedAt: Date,
        public readonly ExpiresAt: Date,
        public readonly Progress: IntentProgress,
        public readonly Failure: IntentFailure | null)
    {
    }

    public static Create(options: { IntentId: string, IntentDigest: string, Level: HiveLevel, Action: IntentAction, IssuedAt: Date, ExpiresAt: Date, Status: IntentStatus }): KeptIntentView
    {
        return KeptIntentView.Parse({
            IntentId: options.IntentId, IntentDigest: options.IntentDigest, Level: options.Level, Action: options.Action.ToJson(),
            IssuedAt: options.IssuedAt.toISOString(), ExpiresAt: options.ExpiresAt.toISOString(), Progress: options.Status.Progress, Failure: options.Status.Failure,
        })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): KeptIntentView
    {
        const F = KeptIntentView.Field
        const fields = StrictFields.Exactly(value, KeptIntentView.Members, path)
        const intentId = fields.String(F.IntentId, { Max: 63, Pattern: ProtocolNames.Label })
        const status = IntentStatus.Parse({ IntentId: intentId, Progress: fields.Enum(F.Progress, IntentStatus.Progresses), Failure: fields.NullableEnum(F.Failure, IntentStatus.Failures) }, path)
        return new KeptIntentView(
            intentId,
            fields.String(F.IntentDigest, { Pattern: ProtocolNames.Digest }),
            fields.Enum(F.Level, HiveLevels.Pulling),
            fields.Read(F.Action, (raw, at) => IntentActions.Parse(raw, at)),
            fields.Timestamp(F.IssuedAt),
            fields.Timestamp(F.ExpiresAt),
            status.Progress,
            status.Failure)
    }

    /** Whether an admin may still approve or reject it (awaiting approval and not expired at `now`). */
    public Decidable(now: Date): boolean
    {
        return this.Progress === IntentProgress.AwaitingApproval && this.ExpiresAt.getTime() > now.getTime()
    }

    public ToJson(): KeptIntentViewJson
    {
        return {
            IntentId: this.IntentId, IntentDigest: this.IntentDigest, Level: this.Level, Action: this.Action.ToJson(),
            IssuedAt: this.IssuedAt.toISOString(), ExpiresAt: this.ExpiresAt.toISOString(), Progress: this.Progress, Failure: this.Failure,
        }
    }
}

/** `GET /internal/intents`: every intent the agent keeps (pending, applied, rejected, failed, expired), newest first. */
export class KeptIntentListing
{
    public static readonly MaxIntents = 500
    private static readonly Field = { Intents: 'Intents' } as const
    private static readonly Members: readonly string[] = Object.values(KeptIntentListing.Field)

    private constructor(public readonly Intents: readonly KeptIntentView[])
    {
    }

    public static Of(intents: readonly KeptIntentView[]): KeptIntentListing
    {
        return KeptIntentListing.Parse({ Intents: intents.map(intent => intent.ToJson()) })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): KeptIntentListing
    {
        const fields = StrictFields.Exactly(value, KeptIntentListing.Members, path)
        return new KeptIntentListing(fields.UniqueArray(KeptIntentListing.Field.Intents, KeptIntentListing.MaxIntents, (raw, at) => KeptIntentView.Parse(raw, at), intent => intent.IntentId))
    }

    public ToJson(): { Intents: KeptIntentViewJson[] }
    {
        return { Intents: this.Intents.map(intent => intent.ToJson()) }
    }
}

/**
 * The intent routes of the hive agent's internal API (C3.4), on the enrolment API's port and behind the same caller
 * check (the console's projected token): `GET /internal/intents` answers a KeptIntentListing; `POST
 * /internal/intents/<id>/decision` takes an IntentDecisionCall, signs the IntentDecision with the hive key, sends it to
 * the platform and, on approve, applies; it answers the intent's KeptIntentView. Refusals are `{ error, code }` with
 * an IntentDecisionRefusal code.
 */
export class IntentInternalLink
{
    public static readonly IntentsPath = '/internal/intents'
    public static readonly DecisionSuffix = '/decision'
    public static readonly Codes: readonly IntentDecisionRefusal[] = Object.values(IntentDecisionRefusal)
    private static readonly Separator = '/'
    private static readonly ErrorText = 'refused'
    private static readonly CodeField = 'code'
    private static readonly Statuses: ReadonlyMap<IntentDecisionRefusal, number> = new Map([
        [IntentDecisionRefusal.Malformed, 400],
        [IntentDecisionRefusal.NotConsole, 403],
        [IntentDecisionRefusal.NotEnrolled, 409],
        [IntentDecisionRefusal.UnknownIntent, 404],
        [IntentDecisionRefusal.NotAwaiting, 409],
        [IntentDecisionRefusal.Expired, 410],
        [IntentDecisionRefusal.DigestMismatch, 409],
        [IntentDecisionRefusal.Unavailable, 503],
    ])

    public static DecisionPath(intentId: string): string
    {
        const L = IntentInternalLink
        return L.IntentsPath + L.Separator + encodeURIComponent(intentId) + L.DecisionSuffix
    }

    /** The intent id a decision path names, or undefined when the path is not one. */
    public static IntentIdOf(path: string): string | undefined
    {
        const L = IntentInternalLink
        const prefix = L.IntentsPath + L.Separator
        if (!path.startsWith(prefix) || !path.endsWith(L.DecisionSuffix))
        {
            return undefined
        }
        const id = path.slice(prefix.length, path.length - L.DecisionSuffix.length)
        return ProtocolNames.Label.test(id) ? id : undefined
    }

    public static StatusOf(code: IntentDecisionRefusal): number
    {
        return IntentInternalLink.Statuses.get(code) as number
    }

    public static RefusalBody(code: IntentDecisionRefusal): { error: string, code: IntentDecisionRefusal }
    {
        return { error: IntentInternalLink.ErrorText, code }
    }

    /** The refusal code a reply body names, when it is one of ours; anything else is null. */
    public static CodeOf(body: unknown): IntentDecisionRefusal | null
    {
        if (!StrictFields.IsObject(body))
        {
            return null
        }
        const code = body[IntentInternalLink.CodeField]
        return typeof code === 'string' && (IntentInternalLink.Codes as readonly string[]).includes(code) ? code as IntentDecisionRefusal : null
    }
}

/** Why the console turned the agent's forwarded intent away before trying it. */
export enum ConsoleIntentRefusal
{
    /** The request is not `{ IntentId, Action }` with a forwarded kind. */
    Malformed = 'malformed',
    /** The caller is not the hive agent (TokenReview: audience and service account). */
    NotAgent = 'not-agent',
    /** The console could not take it now; the agent retries. */
    Unavailable = 'unavailable',
}

/**
 * `POST /internal/environment-intents` from the hive agent to its console (C3.4 ruling "who applies what"): the intent
 * id and its action, one of the kinds the console owns: create, update and delete environment, an environment repair
 * and the ingress-certificate rotation. The console is idempotent per intent id.
 */
export class ConsoleIntentCall
{
    private static readonly Field = { IntentId: 'IntentId', Action: 'Action' } as const
    private static readonly Members: readonly string[] = Object.values(ConsoleIntentCall.Field)
    private static readonly EnvironmentKinds: readonly IntentActionKind[] = [IntentActionKind.CreateEnvironment, IntentActionKind.UpdateEnvironment, IntentActionKind.DeleteEnvironment]

    private constructor(public readonly IntentId: string, public readonly Action: IntentAction)
    {
    }

    /** Whether the console applies this action (the agent applies every other kind itself). */
    public static Forwards(action: IntentAction): boolean
    {
        switch (action.Kind)
        {
            case IntentActionKind.Repair:
                return action.Scope === RepairScope.Environment
            case IntentActionKind.Rotate:
                return action.Subject === RotationSubject.IngressCertificate
            default:
                return ConsoleIntentCall.EnvironmentKinds.includes(action.Kind)
        }
    }

    public static Create(intentId: string, action: IntentAction): ConsoleIntentCall
    {
        return ConsoleIntentCall.Parse({ IntentId: intentId, Action: action.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): ConsoleIntentCall
    {
        const F = ConsoleIntentCall.Field
        const fields = StrictFields.Exactly(value, ConsoleIntentCall.Members, path)
        const intentId = fields.String(F.IntentId, { Max: 63, Pattern: ProtocolNames.Label })
        const action = fields.Read(F.Action, (raw, at) => IntentActions.Parse(raw, at))
        if (!ConsoleIntentCall.Forwards(action))
        {
            throw fields.Refuse(F.Action, DecodeReason.NotAllowed)
        }
        return new ConsoleIntentCall(intentId, action)
    }

    public ToJson(): { IntentId: string, Action: Record<string, unknown> }
    {
        return { IntentId: this.IntentId, Action: this.Action.ToJson() }
    }
}

/** The console's answer to a forwarded intent: applied, or failed with a code. */
export class ConsoleIntentOutcome
{
    public static readonly Progresses: readonly IntentProgress[] = [IntentProgress.Applied, IntentProgress.Failed]
    private static readonly Field = { Progress: 'Progress', Failure: 'Failure' } as const
    private static readonly Members: readonly string[] = Object.values(ConsoleIntentOutcome.Field)
    private static readonly ProbeId = 'outcome'
    public static readonly Applied = new ConsoleIntentOutcome(IntentProgress.Applied, null)

    private constructor(public readonly Progress: IntentProgress, public readonly Failure: IntentFailure | null)
    {
    }

    public static FailedWith(failure: IntentFailure): ConsoleIntentOutcome
    {
        return ConsoleIntentOutcome.Parse({ Progress: IntentProgress.Failed, Failure: failure })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): ConsoleIntentOutcome
    {
        const F = ConsoleIntentOutcome.Field
        const fields = StrictFields.Exactly(value, ConsoleIntentOutcome.Members, path)
        const progress = fields.Enum(F.Progress, ConsoleIntentOutcome.Progresses)
        const status = IntentStatus.Parse({ IntentId: ConsoleIntentOutcome.ProbeId, Progress: progress, Failure: fields.NullableEnum(F.Failure, IntentStatus.Failures) }, path)
        return progress === IntentProgress.Applied ? ConsoleIntentOutcome.Applied : new ConsoleIntentOutcome(progress, status.Failure)
    }

    /** This outcome as the intent's status. */
    public StatusOf(intentId: string): IntentStatus
    {
        return this.Failure === null ? IntentStatus.Of(intentId, this.Progress) : IntentStatus.FailedWith(intentId, this.Failure)
    }

    public ToJson(): { Progress: IntentProgress, Failure: IntentFailure | null }
    {
        return { Progress: this.Progress, Failure: this.Failure }
    }
}

/**
 * The console's internal intent endpoint (C3.4): its own cluster-internal listener on port 7211 behind a ClusterIP
 * Service the chart names, fenced by a NetworkPolicy to the hive agent's pods, each call carrying the agent's projected
 * service-account token for audience `pragmatic-tenant-admin` (TokenReview: audience and the agent's service account).
 * The answer is a ConsoleIntentOutcome, or `{ error, code }` with a ConsoleIntentRefusal code.
 */
export class ConsoleIntentLink
{
    public static readonly Port = 7211
    public static readonly Audience = 'pragmatic-tenant-admin'
    public static readonly Path = '/internal/environment-intents'
    public static readonly BodyLimit = 16_384
    /** Creating an environment provisions its database and waits for its server: the agent waits up to ten minutes. */
    public static readonly TimeoutMs = 600_000
    public static readonly Codes: readonly ConsoleIntentRefusal[] = Object.values(ConsoleIntentRefusal)
    private static readonly ErrorText = 'refused'
    private static readonly CodeField = 'code'
    private static readonly Statuses: ReadonlyMap<ConsoleIntentRefusal, number> = new Map([
        [ConsoleIntentRefusal.Malformed, 400],
        [ConsoleIntentRefusal.NotAgent, 403],
        [ConsoleIntentRefusal.Unavailable, 503],
    ])

    public static StatusOf(code: ConsoleIntentRefusal): number
    {
        return ConsoleIntentLink.Statuses.get(code) as number
    }

    public static RefusalBody(code: ConsoleIntentRefusal): { error: string, code: ConsoleIntentRefusal }
    {
        return { error: ConsoleIntentLink.ErrorText, code }
    }

    public static CodeOf(body: unknown): ConsoleIntentRefusal | null
    {
        if (!StrictFields.IsObject(body))
        {
            return null
        }
        const code = body[ConsoleIntentLink.CodeField]
        return typeof code === 'string' && (ConsoleIntentLink.Codes as readonly string[]).includes(code) ? code as ConsoleIntentRefusal : null
    }
}
