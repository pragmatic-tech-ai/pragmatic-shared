import { createHash, randomBytes } from 'node:crypto'
import type { ISessionRepository } from './session-repository.js'
import { IssuedSession, SessionRecord } from './session-record.js'
import type { SessionClaims } from './session-claims.js'
import type { SessionPolicy } from './session-policy.js'

/**
 * Server-side sessions over an ISessionRepository. A session's bearer token is 32 random bytes (base64url), handed to
 * the caller once (Issue, Rotate) and stored only as its SHA-256 digest, the session id. Grants (Issue, Rotate) are
 * strict: a failed write throws and nothing is valid. Revocations (Revoke, RevokeSubject) fail CLOSED: when the
 * repository cannot write, the store refuses the ended session(s) in this process anyway and rethrows, so a signed-out
 * session is refused at once. A sliding policy renews on use; a failed renewal write keeps the session as it was.
 */
export class SessionStore
{
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly DigestAlgorithm = 'sha256'
    private static readonly DigestEncoding = 'base64url'

    /** Session ids whose revocation could not be written -> until when they are refused here. */
    private readonly refusedIds = new Map<string, number>()
    /** Subjects whose revocation could not be written -> the revocation time (sessions issued until then are refused). */
    private readonly refusedSubjects = new Map<string, number>()
    private longestLifetimeMs: number

    public constructor(private readonly repository: ISessionRepository, private readonly policy: SessionPolicy, private readonly now: () => Date = () => new Date())
    {
        this.longestLifetimeMs = policy.MaxLifetimeMs
    }

    /** The session id a token is stored under: its SHA-256 digest (base64url). */
    public static DigestOf(token: string): string
    {
        return createHash(SessionStore.DigestAlgorithm).update(token).digest(SessionStore.DigestEncoding)
    }

    public async Issue(subject: string, claims: SessionClaims, policy: SessionPolicy = this.policy): Promise<IssuedSession>
    {
        const now = this.now()
        await this.repository.DeleteExpired(now).catch(() => 0)
        const issued = this.NewSession(subject, claims, policy, now)
        await this.repository.Insert(issued.Session)
        return issued
    }

    /** The live session the token names, renewed when its policy slides and it is due; null otherwise. */
    public async Validate(token: string): Promise<SessionRecord | null>
    {
        return token.length === 0 ? null : await this.ValidateId(SessionStore.DigestOf(token))
    }

    /** Validate by session id (a WebSocket ticket carries the id, never the token). */
    public async ValidateId(id: string): Promise<SessionRecord | null>
    {
        const now = this.now()
        if (this.IsRefusedId(id, now))
        {
            return null
        }
        const record = await this.repository.Find(id)
        if (record === null || this.IsRefusedSubject(record))
        {
            return null
        }
        if (!record.IsLive(now))
        {
            await this.repository.Delete(id).catch(() => false)
            return null
        }
        if (!record.Policy.IsDue(record.KeptAt, now))
        {
            return record
        }
        const renewed = record.Extended(record.Policy.RenewedExpiry(record.IssuedAt, now), now)
        try
        {
            return await this.repository.Extend(id, renewed.ExpiresAt, renewed.KeptAt) ? renewed : null
        }
        catch
        {
            // A failed write must not refuse a session that is still valid: keep it un-slid.
            return record
        }
    }

    public async Revoke(token: string): Promise<void>
    {
        const id = SessionStore.DigestOf(token)
        try
        {
            await this.repository.Delete(id)
        }
        catch (err)
        {
            this.refusedIds.set(id, this.now().getTime() + this.longestLifetimeMs)
            throw err
        }
    }

    /** Ends every session of the subject (e.g. its access was withdrawn); returns how many. */
    public async RevokeSubject(subject: string): Promise<number>
    {
        try
        {
            return await this.repository.DeleteSubject(subject)
        }
        catch (err)
        {
            this.refusedSubjects.set(subject, this.now().getTime())
            throw err
        }
    }

    /**
     * After the subject changed its own credential: ends EVERY session of the subject (the caller's too, so a stolen
     * copy is useless) and issues the caller one fresh session with its claims (or `claims`), in one atomic step.
     * Null when the token names no live session.
     */
    public async Rotate(token: string, claims?: SessionClaims): Promise<IssuedSession | null>
    {
        const current = await this.Validate(token)
        if (current === null)
        {
            return null
        }
        const fresh = this.NewSession(current.Subject, claims ?? current.Claims, current.Policy, this.now())
        await this.repository.ReplaceSubject(current.Subject, fresh.Session)
        return fresh
    }

    private NewSession(subject: string, claims: SessionClaims, policy: SessionPolicy, now: Date): IssuedSession
    {
        this.longestLifetimeMs = Math.max(this.longestLifetimeMs, policy.MaxLifetimeMs)
        const token = randomBytes(SessionStore.TokenBytes).toString(SessionStore.TokenEncoding)
        const record = new SessionRecord(SessionStore.DigestOf(token), subject, claims, now, new Date(now.getTime() + policy.TtlMs), now, policy)
        return new IssuedSession(token, record)
    }

    private IsRefusedId(id: string, now: Date): boolean
    {
        for (const [refused, until] of this.refusedIds)
        {
            if (until <= now.getTime())
            {
                this.refusedIds.delete(refused)
            }
        }
        return this.refusedIds.has(id)
    }

    private IsRefusedSubject(record: SessionRecord): boolean
    {
        const stamp = this.refusedSubjects.get(record.Subject)
        return stamp !== undefined && record.IssuedAt.getTime() <= stamp
    }
}
