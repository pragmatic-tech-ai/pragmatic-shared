import type { OidcBeginOptions, OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { ReturnPathPolicy } from './return-path-policy.js'
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
    /** Where a completed sign-in lands when its begin named no admitted return path; default `/`. */
    AfterSignInPath?: string
    /** The path prefixes a begin's `return` may name (ReturnPathPolicy: relative, same-origin, segment-boundary
     *  prefix match). Default none: `return` is ignored. */
    ReturnPaths?: readonly string[]
    /** Where a failed sign-in (begin or callback refused) lands instead of the generic 401: a plain same-origin path,
     *  e.g. `/?sign_in=failed`, the marker pragmatic-app-shell's boot shows as a failed sign-in with Try again. A
     *  malformed callback (no code or state) stays 400. Default none: 401. */
    SignInFailedPath?: string
    /** The policy of the sessions it issues; default the store's. */
    Policy?: SessionPolicy
    /** The session and logout paths, or false when another endpoint registers them. */
    SessionPaths?: SessionEndpointPaths | false
}

/**
 * The OIDC sign-in surface: begin (302 to the IdP's authorize URL; its query may carry `prompt=create` to ask for
 * sign-up, sent only when the issuer advertises `create` in `prompt_values_supported`, a `login_hint` passed through,
 * and a `return` path, admitted by the ReturnPaths policy and carried in the flow state, never in the authorize URL),
 * callback (exchanges the code, issues the session
 * cookie, 302 to the begin's admitted return path, else AfterSignInPath), and the session and logout routes. The client comes from the application's
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
    private static readonly BadFailedPathMessage = 'OidcLoginEndpoint: SignInFailedPath must be a plain same-origin path: '
    private static readonly PromptParam = 'prompt'
    private static readonly PromptCreate = 'create'
    private static readonly LoginHintParam = 'login_hint'
    private static readonly ReturnParam = 'return'
    /** RFC 5321's longest path, so any email fits. */
    private static readonly MaxLoginHintLength = 254
    private static readonly LoginHintForbidden = /[\s\u0000-\u001f\u007f]/

    private readonly afterSignIn: string
    private readonly returnPaths: ReturnPathPolicy
    private readonly signInFailed: string | undefined

    public constructor(private readonly rp: OidcRelyingParty, private readonly clients: IOidcClientProvider, private readonly gate: SessionGate, private readonly options: OidcLoginEndpointOptions = {})
    {
        this.afterSignIn = options.AfterSignInPath ?? OidcLoginEndpoint.DefaultAfterSignInPath
        this.returnPaths = new ReturnPathPolicy(options.ReturnPaths ?? [])
        this.signInFailed = options.SignInFailedPath
        if (this.signInFailed !== undefined && !ReturnPathPolicy.IsPlain(this.signInFailed))
        {
            throw new Error(OidcLoginEndpoint.BadFailedPathMessage + JSON.stringify(this.signInFailed))
        }
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
            const begun = await this.rp.Begin(await this.clients.ClientFor(ctx.Request), this.BeginOptionsOf(ctx))
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
        let returnPath: string | null
        let policy = this.options.Policy
        try
        {
            const outcome = await this.rp.CompleteWithTokens(await this.clients.ClientFor(ctx.Request), code, state)
            identity = outcome.Result
            // Admitted at begin; checked again, as it comes back from storage.
            returnPath = outcome.ReturnPath === null ? null : this.returnPaths.Admit(outcome.ReturnPath)
            if (retention !== undefined)
            {
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
            [OidcLoginEndpoint.LocationHeader]: returnPath ?? this.afterSignIn,
            [OidcLoginEndpoint.SetCookieHeader]: this.gate.Cookie.Build(issued.Token, issued.Session.ExpiresAt),
        })
        ctx.Response.end()
    }

    /** What the begin's query asks for: sign-up, a well-formed login hint, an admitted return path; the rest dropped. */
    private BeginOptionsOf(ctx: RequestContext): OidcBeginOptions
    {
        const E = OidcLoginEndpoint
        const begin: OidcBeginOptions = {}
        if (ctx.Query.get(E.PromptParam) === E.PromptCreate)
        {
            begin.SignUp = true
        }
        const hint = ctx.Query.get(E.LoginHintParam)
        if (hint !== null && hint.length > 0 && hint.length <= E.MaxLoginHintLength && !E.LoginHintForbidden.test(hint))
        {
            begin.LoginHint = hint
        }
        const returnTo = ctx.Query.get(E.ReturnParam)
        const admitted = returnTo === null ? null : this.returnPaths.Admit(returnTo)
        if (admitted !== null)
        {
            begin.ReturnPath = admitted
        }
        return begin
    }

    private Unauthorized(ctx: RequestContext): void
    {
        if (this.signInFailed !== undefined)
        {
            ctx.Response.writeHead(OidcLoginEndpoint.StatusFound, { [OidcLoginEndpoint.LocationHeader]: this.signInFailed })
            ctx.Response.end()
            return
        }
        ctx.WriteJson(OidcLoginEndpoint.StatusUnauthorized, { [OidcLoginEndpoint.ErrorField]: OidcLoginEndpoint.UnauthorizedMessage })
    }
}
