/**
 * Why the platform turned an agent-channel message away. Answered as `{ error, code }` with the HTTP status the code
 * names (AgentExchangeLink.StatusOf); never text from the message. The agent maps them to its own answers.
 */
export enum AgentExchangeRefusal
{
    /** The body is not a protocol envelope, or its body is not the kind's shape. No nonce is burnt. */
    Malformed = 'malformed',
    /** Over the exchange's byte limit. */
    TooLarge = 'too-large',
    /** The envelope did not verify (signature, issuer, audience, key, freshness). */
    NotVerified = 'not-verified',
    /** The envelope's nonce was already claimed from this issuer. */
    Replayed = 'replayed',
    /** A kind the platform does not take on this exchange. */
    UnsupportedKind = 'unsupported-kind',
    /** The enrolment code is unknown, used or expired. */
    InvalidCode = 'invalid-code',
    /** The enrolment code was issued for another tenant, level or kind of agent. */
    Mismatch = 'mismatch',
    /** The key is already registered to a hive or host. */
    KeyRegistered = 'key-registered',
    /** The hive's customer left it: its record is gone. */
    HiveGone = 'hive-gone',
    /** The platform could not take the message now (its store, the admin console behind the edge). */
    Unavailable = 'unavailable',
}

/** A refusal as it crosses the wire. */
export interface AgentExchangeRefusalJson
{
    error: string
    code: AgentExchangeRefusal
}

/**
 * The agent channel's HTTP exchange (C3.3): one POST route, any direction-agnostic exchange. The body is a signed
 * envelope's wire text (`application/json`, at most 1 MiB); the answer is 200 with the platform's envelope, 204 when
 * the platform only acknowledges, or a refusal `{ error, code }`. The edge serves `PublicPath` and relays the bytes
 * verbatim to the platform admin console's internal listener; it never parses an envelope.
 */
export class AgentExchangeLink
{
    public static readonly PublicPath = '/agent/v2/exchange'
    public static readonly BodyLimit = 1_048_576
    public static readonly ContentType = 'application/json'
    public static readonly StatusAnswered = 200
    public static readonly StatusAcknowledged = 204
    public static readonly Codes: readonly AgentExchangeRefusal[] = Object.values(AgentExchangeRefusal)
    private static readonly ErrorText = 'refused'
    private static readonly CodeField = 'code'
    private static readonly Statuses: ReadonlyMap<AgentExchangeRefusal, number> = new Map([
        [AgentExchangeRefusal.Malformed, 400],
        [AgentExchangeRefusal.TooLarge, 413],
        [AgentExchangeRefusal.NotVerified, 401],
        [AgentExchangeRefusal.Replayed, 409],
        [AgentExchangeRefusal.UnsupportedKind, 400],
        [AgentExchangeRefusal.InvalidCode, 403],
        [AgentExchangeRefusal.Mismatch, 403],
        [AgentExchangeRefusal.KeyRegistered, 409],
        [AgentExchangeRefusal.HiveGone, 410],
        [AgentExchangeRefusal.Unavailable, 503],
    ])

    public static StatusOf(code: AgentExchangeRefusal): number
    {
        return AgentExchangeLink.Statuses.get(code) as number
    }

    public static RefusalBody(code: AgentExchangeRefusal): AgentExchangeRefusalJson
    {
        return { error: AgentExchangeLink.ErrorText, code }
    }

    /** The refusal code a reply body names, when it is one of ours; anything else is null. */
    public static CodeOf(body: unknown): AgentExchangeRefusal | null
    {
        if (typeof body !== 'object' || body === null || Array.isArray(body))
        {
            return null
        }
        const code = (body as Record<string, unknown>)[AgentExchangeLink.CodeField]
        return typeof code === 'string' && (AgentExchangeLink.Codes as readonly string[]).includes(code) ? code as AgentExchangeRefusal : null
    }
}
