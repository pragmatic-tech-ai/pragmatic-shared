import type { IncomingMessage } from 'node:http'
import type { SessionStore } from './session-store.js'
import type { SessionCookie } from './session-cookie.js'
import type { SessionRecord } from './session-record.js'
import type { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { SessionTokenRetention } from '../oidc/tokens/session-token-retention.js'

/**
 * The authentication step of the pipeline: the request's session, from its cookie. The token is never logged. An
 * application that retains its sign-ins' upstream tokens (opt-in) gives the gate a SessionTokenRetention; its route
 * handlers then reach the tokens through UpstreamTokens.
 */
export class SessionGate
{
    private static readonly CookieHeader = 'cookie'

    public constructor(public readonly Sessions: SessionStore, public readonly Cookie: SessionCookie, public readonly Tokens?: SessionTokenRetention)
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

    /** The upstream tokens of the request's live session (refreshed when due); null when the application retains none,
     *  there is no live session, or its tokens are gone. */
    public async UpstreamTokens(req: IncomingMessage): Promise<OidcTokenSet | null>
    {
        const token = this.Token(req)
        if (this.Tokens === undefined || token === null || await this.Sessions.Validate(token) === null)
        {
            return null
        }
        return await this.Tokens.Current(req, token)
    }
}
