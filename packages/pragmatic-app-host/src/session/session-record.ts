import type { SessionClaims } from './session-claims.js'
import type { SessionPolicy } from './session-policy.js'

/**
 * One stored session. Id is the SHA-256 digest of the bearer token (the token itself is never stored, logged or put
 * in an error); it is a non-secret handle (a WebSocket ticket binds to it). Subject is who signed in (the realm's
 * subject id); Claims are what the realm said about them. KeptAt is when it was issued or last renewed.
 */
export class SessionRecord
{
    public constructor(
        public readonly Id: string,
        public readonly Subject: string,
        public readonly Claims: SessionClaims,
        public readonly IssuedAt: Date,
        public readonly ExpiresAt: Date,
        public readonly KeptAt: Date,
        public readonly Policy: SessionPolicy)
    {
    }

    public IsLive(now: Date): boolean
    {
        return this.ExpiresAt.getTime() > now.getTime()
    }

    public Extended(expiresAt: Date, keptAt: Date): SessionRecord
    {
        return new SessionRecord(this.Id, this.Subject, this.Claims, this.IssuedAt, expiresAt, keptAt, this.Policy)
    }
}

/** A freshly issued session and its bearer token: the only time the token exists outside the caller's cookie. */
export class IssuedSession
{
    public constructor(public readonly Token: string, public readonly Session: SessionRecord)
    {
    }
}
