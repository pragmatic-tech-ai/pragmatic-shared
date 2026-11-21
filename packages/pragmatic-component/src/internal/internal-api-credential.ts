import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** An unusable internal API secret (missing, unreadable, too short) or label. Names the reason, never the secret. */
export class InternalApiSecretError extends Error
{
    private static readonly ErrorName = 'InternalApiSecretError'
    private static readonly Prefix = 'internal API secret: '

    public constructor(reason: string)
    {
        super(InternalApiSecretError.Prefix + reason)
        this.name = InternalApiSecretError.ErrorName
    }
}

/**
 * One end's identity on an internal (mesh or loopback) link: both ends read the same shared secret; the bearer on the
 * wire is HMAC-SHA256(secret, the link's label), so the secret itself never travels and two links fed the same secret
 * still carry different bearers. Comparison HMACs the presented value too, so its timing never depends on the
 * presented length or content. The default label is the one of the edge to platform admin console internal API.
 */
export class InternalApiCredential
{
    public static readonly DefaultLabel = 'pragmatic-internal-api/v1'
    public static readonly MinSecretBytes = 32
    private static readonly CompareLabel = 'pragmatic-internal-api/compare'
    private static readonly Algorithm = 'sha256'
    private static readonly Encoding = 'base64url'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly Unreadable = 'file is missing or unreadable'
    private static readonly TooShort = 'secret must be at least 32 bytes'
    private static readonly NoLabel = 'the link label must not be empty'

    private readonly bearer: string

    private constructor(private readonly secret: Buffer, label: string)
    {
        this.bearer = createHmac(InternalApiCredential.Algorithm, secret).update(label).digest(InternalApiCredential.Encoding)
    }

    public static FromFile(path: string, label: string = InternalApiCredential.DefaultLabel): InternalApiCredential
    {
        let secret: Buffer
        try
        {
            secret = readFileSync(path)
        }
        catch
        {
            throw new InternalApiSecretError(InternalApiCredential.Unreadable)
        }
        return InternalApiCredential.FromSecret(secret, label)
    }

    public static FromSecret(secret: Buffer, label: string = InternalApiCredential.DefaultLabel): InternalApiCredential
    {
        if (secret.length < InternalApiCredential.MinSecretBytes)
        {
            throw new InternalApiSecretError(InternalApiCredential.TooShort)
        }
        if (label.length === 0)
        {
            throw new InternalApiSecretError(InternalApiCredential.NoLabel)
        }
        return new InternalApiCredential(Buffer.from(secret), label)
    }

    public Bearer(): string
    {
        return this.bearer
    }

    /** The `authorization` header value a caller sends. */
    public AuthorizationValue(): string
    {
        return InternalApiCredential.BearerPrefix + this.bearer
    }

    public Matches(presented: string): boolean
    {
        return timingSafeEqual(this.Digest(presented), this.Digest(this.bearer))
    }

    /** Whether an `authorization` header carries this link's bearer. */
    public MatchesAuthorization(header: string | undefined): boolean
    {
        const match = header === undefined ? null : InternalApiCredential.BearerPattern.exec(header)
        return match !== null && this.Matches(match[1] as string)
    }

    private Digest(value: string): Buffer
    {
        return createHmac(InternalApiCredential.Algorithm, this.secret).update(InternalApiCredential.CompareLabel).update(value).digest()
    }
}
