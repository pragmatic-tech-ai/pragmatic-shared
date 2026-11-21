import type { IncomingMessage } from 'node:http'
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

/** Where a signed-out browser goes next: OidcSignOut, the IdP's end-session endpoint (RP-Initiated Logout). */
export interface ISignOutDestination
{
    /** The signed-out page: the answer when For cannot say. */
    readonly SignedOut: string
    /** The destination of the request's sign-out; `idToken` is the ended session's stored ID token (the
     *  `id_token_hint`), or undefined. */
    For(req: IncomingMessage, idToken: string | undefined): Promise<string>
}

export interface SessionEndpointOptions
{
    /** Makes logout answer 200 `{ redirect }`; absent: 204. */
    SignOut?: ISignOutDestination
    /** Where a failed revocation, token deletion or destination is reported: a fixed sentence and the error (never a
     *  token). Default console.error. */
    Log?: (message: string, err?: unknown) => void
}

/**
 * Session introspection and sign-out, for every sign-in method: GET session answers the subject and claims (401
 * without a session); POST logout ends the session (and its retained upstream tokens) and clears the cookie. Without a
 * sign-out destination (password-only applications) logout answers 204; with one (OIDC sign-in, OidcLoginEndpoint) it
 * answers 200 `{ redirect }`, where the browser goes next to end the IdP's session too, the ID token read before the
 * session ends. Logout is public (a stale cookie can still sign out) but, being a mutation, Origin-guarded. A
 * revocation fails closed, so a failed write still answers signed out. Both answers are no-store; no token is logged.
 */
export class SessionEndpoint
{
    /** The logout answer's member naming where the browser goes next. */
    public static readonly RedirectField = 'redirect'
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
    private static readonly RevokeFailed = 'ending a session at logout failed (it is refused in this process):'
    private static readonly ForgetFailed = 'forgetting the retained tokens of a session at logout failed:'
    private static readonly DestinationFailed = 'the sign-out destination failed; answering the signed-out page:'
    private static readonly HintFailed = 'reading the stored ID token at logout failed; signing out without a hint:'

    private readonly signOut: ISignOutDestination | undefined
    private readonly log: (message: string, err?: unknown) => void

    public constructor(private readonly gate: SessionGate, options: SessionEndpointOptions = {})
    {
        this.signOut = options.SignOut
        this.log = options.Log ?? SessionEndpoint.ConsoleLog
    }

    /** The default report of a failure: the sentence, and the error when there is one. */
    public static ConsoleLog(message: string, err?: unknown): void
    {
        if (err === undefined)
        {
            console.error(message)
            return
        }
        console.error(message, err)
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
        CacheControl.NoStore(ctx.Response)
        ctx.Response.setHeader(SessionEndpoint.SetCookieHeader, this.gate.Cookie.BuildClearing())
        // The hint for the IdP's end-session, read (never refreshed) while the session and its tokens still exist.
        const idToken = this.signOut === undefined || token === null ? undefined : await this.IdTokenOf(ctx.Request)
        if (token !== null)
        {
            await this.EndSession(token)
        }
        if (this.signOut === undefined)
        {
            ctx.Response.writeHead(SessionEndpoint.StatusNoContent)
            ctx.Response.end()
            return
        }
        ctx.WriteJson(SessionEndpoint.StatusOk, { [SessionEndpoint.RedirectField]: await this.DestinationOf(this.signOut, ctx.Request, idToken) })
    }

    // A failed revocation fails closed in the store (the session is refused in this process).
    private async EndSession(token: string): Promise<void>
    {
        try
        {
            await this.gate.Sessions.Revoke(token)
        }
        catch (err)
        {
            this.log(SessionEndpoint.RevokeFailed, err)
        }
        try
        {
            await this.gate.Tokens?.Forget(token)
        }
        catch (err)
        {
            this.log(SessionEndpoint.ForgetFailed, err)
        }
    }

    private async IdTokenOf(req: IncomingMessage): Promise<string | undefined>
    {
        try
        {
            return await this.gate.StoredIdToken(req)
        }
        catch (err)
        {
            // No hint: the IdP then asks the person to confirm the sign-out.
            this.log(SessionEndpoint.HintFailed, err)
            return undefined
        }
    }

    private async DestinationOf(signOut: ISignOutDestination, req: IncomingMessage, idToken: string | undefined): Promise<string>
    {
        try
        {
            return await signOut.For(req, idToken)
        }
        catch (err)
        {
            this.log(SessionEndpoint.DestinationFailed, err)
            return signOut.SignedOut
        }
    }
}
