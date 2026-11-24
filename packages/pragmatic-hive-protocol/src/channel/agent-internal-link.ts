import { ConsoleAddress } from '../hive/console-address.js'
import { HiveLevel, HiveLevels } from '../hive/hive-level.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/**
 * Why the hive agent did not enrol when the engine's console asked ("connect this hive", C3.3). The console shows a
 * fixed message per code; nothing from the platform's answer travels.
 */
export enum HiveEnrolmentRefusal
{
    /** The request is not `{ Code, Level, ConsoleAddress }`, or Standalone was asked. */
    Malformed = 'malformed',
    /** The caller is not the engine's console (TokenReview: audience and service account). */
    NotConsole = 'not-console',
    /** The code is unknown, used or expired. */
    InvalidCode = 'invalid-code',
    /** The code was issued for another tenant or level. */
    Mismatch = 'mismatch',
    /** This hive is enrolled already. */
    AlreadyEnrolled = 'already-enrolled',
    /** This hive's key is registered to a live hive on the platform. */
    KeyRegistered = 'key-registered',
    /** The platform answered under another trust root than the one the engine was installed with. */
    TrustRootMismatch = 'trust-root-mismatch',
    /** The platform could not be reached or refused the message otherwise; try again. */
    Unavailable = 'unavailable',
}

/** `POST /internal/enrol`: the one-time code, the level asked and where the console is reached. */
export class HiveEnrolmentCall
{
    private static readonly Field = { Code: 'Code', Level: 'Level', ConsoleAddress: 'ConsoleAddress' } as const
    private static readonly Members: readonly string[] = Object.values(HiveEnrolmentCall.Field)
    /** The levels the console may ask for: Hosted is enrolled by the host agent only. */
    public static readonly Levels: readonly HiveLevel[] = HiveLevels.Pulling

    private constructor(public readonly Code: string, public readonly Level: HiveLevel, public readonly ConsoleAddress: ConsoleAddress)
    {
    }

    public static Create(code: string, level: HiveLevel, consoleAddress: ConsoleAddress): HiveEnrolmentCall
    {
        return HiveEnrolmentCall.Parse({ Code: code, Level: level, ConsoleAddress: consoleAddress.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveEnrolmentCall
    {
        const F = HiveEnrolmentCall.Field
        const fields = StrictFields.Exactly(value, HiveEnrolmentCall.Members, path)
        return new HiveEnrolmentCall(
            fields.String(F.Code, { Max: 128, Pattern: ProtocolNames.EnrolmentCode }),
            fields.Enum(F.Level, HiveEnrolmentCall.Levels),
            fields.Read(F.ConsoleAddress, (raw, at) => ConsoleAddress.Parse(raw, at)))
    }

    public ToJson(): { Code: string, Level: HiveLevel, ConsoleAddress: ReturnType<ConsoleAddress['ToJson']> }
    {
        return { Code: this.Code, Level: this.Level, ConsoleAddress: this.ConsoleAddress.ToJson() }
    }
}

export interface HiveEnrolmentStatusJson
{
    Enrolled: boolean
    HiveId: string | null
    Tenant: string | null
    Level: HiveLevel | null
}

/** `GET /internal/enrolment` and the answer to an enrolment: whether the hive is enrolled, and as what. */
export class HiveEnrolmentStatus
{
    private static readonly Field = { Enrolled: 'Enrolled', HiveId: 'HiveId', Tenant: 'Tenant', Level: 'Level' } as const
    private static readonly Members: readonly string[] = Object.values(HiveEnrolmentStatus.Field)
    public static readonly NotEnrolled = new HiveEnrolmentStatus(false, null, null, null)

    private constructor(public readonly Enrolled: boolean, public readonly HiveId: string | null, public readonly Tenant: string | null, public readonly Level: HiveLevel | null)
    {
    }

    public static Of(hiveId: string, tenant: string, level: HiveLevel): HiveEnrolmentStatus
    {
        return HiveEnrolmentStatus.Parse({ Enrolled: true, HiveId: hiveId, Tenant: tenant, Level: level })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveEnrolmentStatus
    {
        const F = HiveEnrolmentStatus.Field
        const fields = StrictFields.Exactly(value, HiveEnrolmentStatus.Members, path)
        const enrolled = fields.Boolean(F.Enrolled)
        if (!enrolled)
        {
            for (const name of [F.HiveId, F.Tenant, F.Level])
            {
                if (fields.NullableRead(name, () => true) !== null)
                {
                    throw fields.Refuse(name, DecodeReason.Inconsistent)
                }
            }
            return HiveEnrolmentStatus.NotEnrolled
        }
        return new HiveEnrolmentStatus(true,
            fields.String(F.HiveId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.String(F.Tenant, { Pattern: ProtocolNames.Tenant }),
            fields.Enum(F.Level, HiveLevels.Enrolling))
    }

    public ToJson(): HiveEnrolmentStatusJson
    {
        return { Enrolled: this.Enrolled, HiveId: this.HiveId, Tenant: this.Tenant, Level: this.Level }
    }
}

/**
 * The hive agent's cluster-internal API the engine's console calls (C3.3 ruling "console ↔ agent"): a ClusterIP
 * Service on port 7210, fenced by a NetworkPolicy to the console's pods, each call carrying the console's projected
 * service-account token for audience `pragmatic-hive-agent`, checked by TokenReview (audience and username). Refusals
 * are `{ error, code }` with a HiveEnrolmentRefusal code.
 */
export class AgentInternalLink
{
    public static readonly Port = 7210
    public static readonly ServiceName = 'pragmatic-hive-agent-internal'
    public static readonly Audience = 'pragmatic-hive-agent'
    public static readonly EnrolPath = '/internal/enrol'
    public static readonly EnrolmentPath = '/internal/enrolment'
    public static readonly BodyLimit = 16_384
    public static readonly Codes: readonly HiveEnrolmentRefusal[] = Object.values(HiveEnrolmentRefusal)
    private static readonly ErrorText = 'refused'
    private static readonly CodeField = 'code'
    private static readonly Statuses: ReadonlyMap<HiveEnrolmentRefusal, number> = new Map([
        [HiveEnrolmentRefusal.Malformed, 400],
        [HiveEnrolmentRefusal.NotConsole, 403],
        [HiveEnrolmentRefusal.InvalidCode, 422],
        [HiveEnrolmentRefusal.Mismatch, 422],
        [HiveEnrolmentRefusal.AlreadyEnrolled, 409],
        [HiveEnrolmentRefusal.KeyRegistered, 409],
        [HiveEnrolmentRefusal.TrustRootMismatch, 502],
        [HiveEnrolmentRefusal.Unavailable, 503],
    ])

    public static StatusOf(code: HiveEnrolmentRefusal): number
    {
        return AgentInternalLink.Statuses.get(code) as number
    }

    public static RefusalBody(code: HiveEnrolmentRefusal): { error: string, code: HiveEnrolmentRefusal }
    {
        return { error: AgentInternalLink.ErrorText, code }
    }

    /** The refusal code a reply body names, when it is one of ours; anything else is null. */
    public static CodeOf(body: unknown): HiveEnrolmentRefusal | null
    {
        if (typeof body !== 'object' || body === null || Array.isArray(body))
        {
            return null
        }
        const code = (body as Record<string, unknown>)[AgentInternalLink.CodeField]
        return typeof code === 'string' && (AgentInternalLink.Codes as readonly string[]).includes(code) ? code as HiveEnrolmentRefusal : null
    }
}
