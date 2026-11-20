import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SessionStore } from '../../session/session-store.js'

/**
 * Seals a session's upstream tokens (OidcTokenSet) for storage beside the session: AES-256-GCM under a key derived by
 * HKDF-SHA256 from the application's key (its master key, or a configured secret of at least 32 bytes) together with
 * the session's bearer (salt: the session id, info: a fixed label), the session id bound as additional data. The
 * bearer exists only in the browser's HttpOnly cookie and the store keeps its digest, so neither a database read nor
 * the key alone opens a seal. A seal that does not open (another bearer or key, tampered) is simply absent.
 */
export class SessionTokenVault
{
    private static readonly Info = 'pragmatic-app-host/session-tokens/v1'
    private static readonly Digest = 'sha256'
    private static readonly Cipher = 'aes-256-gcm'
    private static readonly MinKeyBytes = 32
    private static readonly KeyBytes = 32
    private static readonly IvBytes = 12
    private static readonly TagBytes = 16
    private static readonly Encoding = 'base64url'
    private static readonly Utf8 = 'utf8'
    private static readonly ShortKeyMessage = 'SessionTokenVault: the key must be at least 32 bytes'
    private static readonly SubjectField = 'sub'
    private static readonly IdTokenField = 'id'
    private static readonly IdExpiresField = 'idExp'
    private static readonly AccessTokenField = 'at'
    private static readonly AccessExpiresField = 'atExp'
    private static readonly RefreshTokenField = 'rt'

    private readonly key: Buffer

    public constructor(key: Buffer)
    {
        if (key.length < SessionTokenVault.MinKeyBytes)
        {
            throw new Error(SessionTokenVault.ShortKeyMessage)
        }
        this.key = Buffer.from(key)
    }

    /** A vault keyed by a configured secret's text (UTF-8, at least 32 bytes). */
    public static FromSecret(secret: string): SessionTokenVault
    {
        return new SessionTokenVault(Buffer.from(secret, SessionTokenVault.Utf8))
    }

    public Seal(bearer: string, tokens: OidcTokenSet): string
    {
        const V = SessionTokenVault
        const sessionId = SessionStore.DigestOf(bearer)
        const iv = randomBytes(V.IvBytes)
        const cipher = createCipheriv(V.Cipher, this.KeyOf(bearer, sessionId), iv)
        cipher.setAAD(Buffer.from(sessionId, V.Utf8))
        const body = Buffer.concat([cipher.update(V.Serialize(tokens), V.Utf8), cipher.final()])
        return Buffer.concat([iv, body, cipher.getAuthTag()]).toString(V.Encoding)
    }

    /** The token set the seal holds for this bearer's session; undefined when it does not open. */
    public Open(bearer: string, sealed: string): OidcTokenSet | undefined
    {
        const V = SessionTokenVault
        try
        {
            const sessionId = SessionStore.DigestOf(bearer)
            const bytes = Buffer.from(sealed, V.Encoding)
            if (bytes.length <= V.IvBytes + V.TagBytes)
            {
                return undefined
            }
            const iv = bytes.subarray(0, V.IvBytes)
            const tag = bytes.subarray(bytes.length - V.TagBytes)
            const body = bytes.subarray(V.IvBytes, bytes.length - V.TagBytes)
            const decipher = createDecipheriv(V.Cipher, this.KeyOf(bearer, sessionId), iv)
            decipher.setAAD(Buffer.from(sessionId, V.Utf8))
            decipher.setAuthTag(tag)
            return V.Deserialize(Buffer.concat([decipher.update(body), decipher.final()]).toString(V.Utf8))
        }
        catch
        {
            return undefined
        }
    }

    private KeyOf(bearer: string, sessionId: string): Buffer
    {
        const V = SessionTokenVault
        const material = Buffer.concat([this.key, Buffer.from(bearer, V.Utf8)])
        return Buffer.from(hkdfSync(V.Digest, material, Buffer.from(sessionId, V.Utf8), Buffer.from(V.Info, V.Utf8), V.KeyBytes))
    }

    private static Serialize(tokens: OidcTokenSet): string
    {
        const V = SessionTokenVault
        return JSON.stringify({
            [V.SubjectField]: tokens.Subject,
            [V.IdTokenField]: tokens.IdToken,
            [V.IdExpiresField]: tokens.IdTokenExpiresAt.getTime(),
            [V.AccessTokenField]: tokens.AccessToken,
            [V.AccessExpiresField]: tokens.AccessTokenExpiresAt?.getTime() ?? null,
            [V.RefreshTokenField]: tokens.RefreshToken,
        })
    }

    private static Deserialize(text: string): OidcTokenSet | undefined
    {
        const V = SessionTokenVault
        const body = JSON.parse(text) as Record<string, unknown>
        const subject = body[V.SubjectField]
        const idToken = body[V.IdTokenField]
        const idExpires = body[V.IdExpiresField]
        const access = body[V.AccessTokenField]
        const accessExpires = body[V.AccessExpiresField]
        const refresh = body[V.RefreshTokenField]
        if (typeof subject !== 'string' || typeof idToken !== 'string' || typeof idExpires !== 'number')
        {
            return undefined
        }
        return new OidcTokenSet(
            subject,
            idToken,
            new Date(idExpires),
            typeof access === 'string' ? access : null,
            typeof accessExpires === 'number' ? new Date(accessExpires) : null,
            typeof refresh === 'string' ? refresh : null)
    }
}
