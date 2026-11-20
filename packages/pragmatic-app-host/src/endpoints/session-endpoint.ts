import type { SessionGate } from '../session/session-gate.js'
import type { RouteTable } from '../routing/route-table.js'
import { RouteAuth } from '../routing/route.js'
import type { RequestContext } from '../routing/request-context.js'
import { HttpMethod } from '../http/http-method.js'
import { JsonApi } from '../http/json-api.js'
import { CacheControl } from '../http/cache-control.js'

export interface SessionEndpointPaths
{
    /** Default `/api/session`. */
    Session?: string
    /** Default `/api/logout`. */
    Logout?: string
}

/**
 * Session introspection and sign-out, for every sign-in method: GET session answers the subject and claims (401
 * without a session); POST logout ends the session and clears the cookie. Logout is public (a stale cookie can still
 * sign out) but, being a mutation, Origin-guarded. A revocation fails closed, so a failed write still answers signed
 * out. Both answers are no-store.
 */
export class SessionEndpoint
{
    private static readonly DefaultSessionPath = '/api/session'
    private static readonly DefaultLogoutPath = '/api/logout'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly StatusOk = 200
    private static readonly StatusNoContent = 204
    private static readonly StatusUnauthorized = 401
    private static readonly ErrorField = 'error'
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly SubjectField = 'subject'
    private static readonly ClaimsField = 'claims'

    public constructor(private readonly gate: SessionGate)
    {
    }

    public Register(table: RouteTable, paths: SessionEndpointPaths = {}): void
    {
        table.Add({ Method: HttpMethod.Get, Pattern: paths.Session ?? SessionEndpoint.DefaultSessionPath, Auth: RouteAuth.Public, Handler: ctx => this.Session(ctx) })
        table.Add({ Method: HttpMethod.Post, Pattern: paths.Logout ?? SessionEndpoint.DefaultLogoutPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.Logout(ctx) })
    }

    private async Session(ctx: RequestContext): Promise<void>
    {
        CacheControl.NoStore(ctx.Response)
        if (ctx.Session === null)
        {
            ctx.WriteJson(SessionEndpoint.StatusUnauthorized, { [SessionEndpoint.ErrorField]: SessionEndpoint.UnauthenticatedMessage })
            return
        }
        ctx.WriteJson(SessionEndpoint.StatusOk, { [SessionEndpoint.SubjectField]: ctx.Session.Subject, [SessionEndpoint.ClaimsField]: ctx.Session.Claims.ToJson() })
    }

    private async Logout(ctx: RequestContext): Promise<void>
    {
        JsonApi.Drain(ctx.Request)
        const token = this.gate.Token(ctx.Request)
        if (token !== null)
        {
            try
            {
                await this.gate.Sessions.Revoke(token)
            }
            catch
            {
                // Already refused in this process (fail closed); the token is never logged.
            }
        }
        CacheControl.NoStore(ctx.Response)
        ctx.Response.setHeader(SessionEndpoint.SetCookieHeader, this.gate.Cookie.BuildClearing())
        ctx.Response.writeHead(SessionEndpoint.StatusNoContent)
        ctx.Response.end()
    }
}
