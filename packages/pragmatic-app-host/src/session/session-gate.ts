import type { IncomingMessage } from 'node:http'
import type { SessionStore } from './session-store.js'
import type { SessionCookie } from './session-cookie.js'
import type { SessionRecord } from './session-record.js'

/** The authentication step of the pipeline: the request's session, from its cookie. The token is never logged. */
export class SessionGate
{
    private static readonly CookieHeader = 'cookie'

    public constructor(public readonly Sessions: SessionStore, public readonly Cookie: SessionCookie)
    {
    }

    /** The bearer token the request's cookie carries, or null. */
    public Token(req: IncomingMessage): string | null
    {
        return this.Cookie.Read(req.headers[SessionGate.CookieHeader])
    }

    /** The request's live session, or null when there is no (well-formed) cookie or it names no live session. */
    public async Current(req: IncomingMessage): Promise<SessionRecord | null>
    {
        const token = this.Token(req)
        return token === null ? null : await this.Sessions.Validate(token)
    }
}
