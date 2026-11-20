import type { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { OidcRelyingParty } from './oidc-relying-party.js'
import type { IOidcClientProvider } from './oidc-client-config.js'
import type { SessionGate } from '../session/session-gate.js'
import type { SignedInIdentity } from '../session/signed-in-identity.js'
import type { SessionPolicy } from '../session/session-policy.js'
import type { RouteTable } from '../routing/route-table.js'
import { RouteAuth } from '../routing/route.js'
import type { RequestContext } from '../routing/request-context.js'
import { HttpMethod } from '../http/http-method.js'
import { CacheControl } from '../http/cache-control.js'
import { SessionEndpoint } from '../endpoints/session-endpoint.js'
import type { SessionEndpointPaths } from '../endpoints/session-endpoint.js'

export interface OidcLoginEndpointOptions
{
    /** Default `/auth/oidc/begin`. */
    BeginPath?: string
    /** Default `/auth/oidc/callback` (the RedirectUri of the client config must point here). */
    CallbackPath?: string
    /** Where a completed sign-in lands; default `/`. */
    AfterSignInPath?: string
    /** The policy of the sessions it issues; default the store's. */
    Policy?: SessionPolicy
    /** The session and logout paths, or false when another endpoint registers them. */
    SessionPaths?: SessionEndpointPaths | false
}

/**
 * The OIDC sign-in surface: begin (302 to the IdP's authorize URL), callback (exchanges the code, issues the session
 * cookie, 302 to the application), and the session and logout routes. The client comes from the application's
 * IOidcClientProvider, per request. The token travels only in the Set-Cookie of a successful callback; a failed sign-in
 * is a generic 401 with no cookie; neither the token nor the code is ever logged or echoed. Every answer is no-store.
 * The session cookie defaults to SameSite=Lax under it (SessionCookie.AdmitCrossSiteSignIn). With a
 * SessionTokenRetention on the gate the sign-in's upstream tokens are retained beside the session (opt-in).
 */
export class OidcLoginEndpoint
{
    private static readonly DefaultBeginPath = '/auth/oidc/begin'
    private static readonly DefaultCallbackPath = '/auth/oidc/callback'
    private static readonly DefaultAfterSignInPath = '/'
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly LocationHeader = 'Location'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly StatusFound = 302
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly ErrorField = 'error'
    private static readonly BadRequestMessage = 'code and state are required'
    private static readonly UnauthorizedMessage = 'Sign-in failed'

    private readonly afterSignIn: string

    public constructor(private readonly rp: OidcRelyingParty, private readonly clients: IOidcClientProvider, private readonly gate: SessionGate, private readonly options: OidcLoginEndpointOptions = {})
    {
        this.afterSignIn = options.AfterSignInPath ?? OidcLoginEndpoint.DefaultAfterSignInPath
        // The callback arrives as a cross-site redirect from the login page: a Strict cookie would not be sent on the
        // navigation that follows it, so the session cookie defaults to Lax (a configured mode stays).
        gate.Cookie.AdmitCrossSiteSignIn()
    }

    public Register(table: RouteTable): void
    {
        table.Add({ Method: HttpMethod.Get, Pattern: this.options.BeginPath ?? OidcLoginEndpoint.DefaultBeginPath, Auth: RouteAuth.Public, Handler: ctx => this.Begin(ctx) })
        table.Add({ Method: HttpMethod.Get, Pattern: this.options.CallbackPath ?? OidcLoginEndpoint.DefaultCallbackPath, Auth: RouteAuth.Public, Handler: ctx => this.Callback(ctx) })
        if (this.options.SessionPaths !== false)
        {
            new SessionEndpoint(this.gate).Register(table, this.options.SessionPaths ?? {})
        }
    }

    private async Begin(ctx: RequestContext): Promise<void>
    {
        CacheControl.NoStore(ctx.Response)
        try
        {
            const begun = await this.rp.Begin(await this.clients.ClientFor(ctx.Request))
            ctx.Response.writeHead(OidcLoginEndpoint.StatusFound, { [OidcLoginEndpoint.LocationHeader]: begun.Url })
            ctx.Response.end()
        }
        catch
        {
            this.Unauthorized(ctx)
        }
    }

    private async Callback(ctx: RequestContext): Promise<void>
    {
        CacheControl.NoStore(ctx.Response)
        const code = ctx.Query.get(OidcLoginEndpoint.CodeParam)
        const state = ctx.Query.get(OidcLoginEndpoint.StateParam)
        if (code === null || code.length === 0 || state === null || state.length === 0)
        {
            ctx.WriteJson(OidcLoginEndpoint.StatusBadRequest, { [OidcLoginEndpoint.ErrorField]: OidcLoginEndpoint.BadRequestMessage })
            return
        }
        const retention = this.gate.Tokens
        let identity: SignedInIdentity
        let tokens: OidcTokenSet | null = null
        let policy = this.options.Policy
        try
        {
            const client = await this.clients.ClientFor(ctx.Request)
            if (retention === undefined)
            {
                identity = await this.rp.Complete(client, code, state)
            }
            else
            {
                const outcome = await this.rp.CompleteWithTokens(client, code, state)
                identity = outcome.Result
                tokens = outcome.Tokens
                policy = retention.PolicyFor(outcome.Tokens as OidcTokenSet, policy)
            }
        }
        catch
        {
            // The relying party collapses every failure to OidcLoginError; a provider that refuses (no such realm), or
            // retained tokens already about to expire, is the same generic refusal.
            this.Unauthorized(ctx)
            return
        }
        const issued = await this.gate.Sessions.Issue(identity.Subject, identity.Claims, policy)
        if (retention !== undefined && tokens !== null)
        {
            await retention.Keep(issued, tokens)
        }
        ctx.Response.writeHead(OidcLoginEndpoint.StatusFound, {
            [OidcLoginEndpoint.LocationHeader]: this.afterSignIn,
            [OidcLoginEndpoint.SetCookieHeader]: this.gate.Cookie.Build(issued.Token, issued.Session.ExpiresAt),
        })
        ctx.Response.end()
    }

    private Unauthorized(ctx: RequestContext): void
    {
        ctx.WriteJson(OidcLoginEndpoint.StatusUnauthorized, { [OidcLoginEndpoint.ErrorField]: OidcLoginEndpoint.UnauthorizedMessage })
    }
}
