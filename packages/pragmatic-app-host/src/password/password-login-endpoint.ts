import type { IPasswordAuthenticator } from './password-authenticator.js'
import type { SessionGate } from '../session/session-gate.js'
import type { LoginThrottle } from '../limits/login-throttle.js'
import type { RouteTable } from '../routing/route-table.js'
import { RouteAuth } from '../routing/route.js'
import type { RequestContext } from '../routing/request-context.js'
import { HttpMethod } from '../http/http-method.js'
import { CacheControl } from '../http/cache-control.js'

/**
 * The optional password sign-in: POST `{ email, password }`, throttled per (account, client address). The attempt is
 * counted at the gate before the password is checked (so a parallel burst lets only the throttle's MaxAttempts reach
 * the authenticator) and wiped on success. A right password issues a session under the same cookie and authorization
 * as every other sign-in method; a wrong one is a generic 401 with no cookie. Not audited (no subject yet; the body
 * is never recorded).
 */
export class PasswordLoginEndpoint
{
    private static readonly DefaultPath = '/api/login'
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly SubjectField = 'subject'
    private static readonly ErrorField = 'error'
    private static readonly CredentialsRequiredMessage = 'email and password are required'
    private static readonly InvalidCredentialsMessage = 'Invalid credentials'
    private static readonly TooManyAttemptsMessage = 'Too many sign-in attempts'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly StatusOk = 200
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusTooManyRequests = 429
    private static readonly MaxBodyBytes = 16 * 1024

    public constructor(private readonly authenticator: IPasswordAuthenticator, private readonly gate: SessionGate, private readonly throttle: LoginThrottle)
    {
    }

    public Register(table: RouteTable, path: string = PasswordLoginEndpoint.DefaultPath): void
    {
        table.Add({ Method: HttpMethod.Post, Pattern: path, Auth: RouteAuth.Public, Audited: false, BodyLimit: PasswordLoginEndpoint.MaxBodyBytes, Handler: ctx => this.Login(ctx) })
    }

    private async Login(ctx: RequestContext): Promise<void>
    {
        const P = PasswordLoginEndpoint
        CacheControl.NoStore(ctx.Response)
        const body = await ctx.ReadJsonObject()
        const email = body[P.EmailField]
        const password = body[P.PasswordField]
        if (typeof email !== 'string' || typeof password !== 'string' || email.length === 0)
        {
            ctx.WriteJson(P.StatusBadRequest, { [P.ErrorField]: P.CredentialsRequiredMessage })
            return
        }
        const gate = await this.throttle.Attempt(email, ctx.ClientAddress)
        if (!gate.Allowed)
        {
            ctx.Response.setHeader(P.RetryAfterHeader, String(gate.RetryAfterSeconds()))
            ctx.WriteJson(P.StatusTooManyRequests, { [P.ErrorField]: P.TooManyAttemptsMessage })
            return
        }
        const identity = await this.authenticator.Authenticate(email, password)
        if (identity === null)
        {
            ctx.WriteJson(P.StatusUnauthorized, { [P.ErrorField]: P.InvalidCredentialsMessage })
            return
        }
        await this.throttle.Succeeded(email, ctx.ClientAddress)
        const issued = await this.gate.Sessions.Issue(identity.Subject, identity.Claims)
        ctx.Response.setHeader(P.SetCookieHeader, this.gate.Cookie.Build(issued.Token, issued.Session.ExpiresAt))
        ctx.WriteJson(P.StatusOk, { [P.SubjectField]: identity.Subject })
    }
}
