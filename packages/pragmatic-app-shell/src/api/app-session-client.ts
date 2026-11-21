import type { IPageLocation, IPageNavigator } from '../browser/browser-page.js'
import { AppShellConfig } from '../config/app-shell-config.js'
import { SignInMethod } from '../config/sign-in-method.js'
import { ApiClientBase, AuthFailureSignal, type FetchFunction } from './api-client-base.js'
import { ApiError } from './api-error.js'
import { AppSession, type AppSessionWire } from './app-session.js'

/** The own-password change reply. Field names mirror the wire. */
export interface PasswordChanged
{
    readonly ok: boolean
    /** False when the application could not sign the other sessions out; `warning` then says so. */
    readonly otherSessionsEnded: boolean
    readonly warning?: string
}

/**
 * The client of the app-host's sign-in surface: the session probe, both sign-in methods, logout, WebSocket tickets
 * and the application's own-password change. An application's API client derives from it, so every one of its
 * requests raises the same `Unauthorized` signal the session service listens to.
 */
export class AppSessionClient extends ApiClientBase
{
    private static readonly EmailField = 'email'
    private static readonly PasswordField = 'password'
    private static readonly TicketField = 'ticket'
    private static readonly CurrentPasswordField = 'currentPassword'
    private static readonly NewPasswordField = 'newPassword'
    private static readonly ConfirmPasswordField = 'confirmPassword'
    private static readonly HttpsProtocol = 'https:'
    private static readonly SecureSocketScheme = 'wss://'
    private static readonly SocketScheme = 'ws://'
    private static readonly NoPasswordSignIn = 'AppSessionClient: this application does not offer password sign-in'
    private static readonly NoOidcSignIn = 'AppSessionClient: this application does not offer OIDC sign-in'
    private static readonly NoChangePassword = 'AppSessionClient: no change-password path is configured'
    private static readonly NoTicket = 'AppSessionClient: the ticket reply carries no ticket'
    private static readonly RedirectField = 'redirect'
    private static readonly WebProtocols: ReadonlySet<string> = new Set(['https:', 'http:'])

    public constructor(config: AppShellConfig, fetcher?: FetchFunction)
    {
        super(config, fetcher)
    }

    /** The signed-in session, or null when there is none (401, which is not an expiry here: nothing was signed in). */
    public async Session(): Promise<AppSession | null>
    {
        try
        {
            const wire = await this.Get<AppSessionWire>(this.Config.Paths.Session, AuthFailureSignal.Quiet)
            return AppSession.FromWire(wire, this.Config)
        }
        catch (e)
        {
            if (ApiError.Is(e, ApiError.UnauthorizedStatus))
            {
                return null
            }
            throw e
        }
    }

    /** Signs in with a local password; the session cookie arrives with the reply. A wrong password rejects (401) without raising expiry. */
    public async PasswordLogin(email: string, password: string): Promise<void>
    {
        if (!this.Config.Offers(SignInMethod.Password))
        {
            throw new Error(AppSessionClient.NoPasswordSignIn)
        }
        const body = { [AppSessionClient.EmailField]: email, [AppSessionClient.PasswordField]: password }
        await this.Post<unknown>(this.Config.Paths.PasswordLogin, body, AuthFailureSignal.Quiet)
    }

    /** Starts the OIDC sign-in: the browser leaves for the begin route, which redirects to the realm's sign-in service. */
    public BeginOidcSignIn(navigator: IPageNavigator): void
    {
        if (!this.Config.Offers(SignInMethod.Oidc))
        {
            throw new Error(AppSessionClient.NoOidcSignIn)
        }
        navigator.Assign(this.Url(this.Config.Paths.OidcBegin))
    }

    /**
     * Ends the session (the cookie is cleared by the reply) and answers where the browser goes next: an OIDC host's
     * `{ redirect }`, the IdP's end-session endpoint (so its SSO session ends too) or a signed-out page; undefined for a
     * 204 (a password-only host: reload). The session is gone either way, so an answer it cannot trust (not an http(s)
     * URL nor an own-origin path) leads to Paths.SignedOut, or undefined without one.
     */
    public async Logout(): Promise<string | undefined>
    {
        const reply = await this.Post<unknown>(this.Config.Paths.Logout)
        if (reply === undefined)
        {
            return undefined
        }
        const redirect = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>)[AppSessionClient.RedirectField] : undefined
        if (typeof redirect === 'string' && AppSessionClient.IsDestination(redirect))
        {
            return redirect
        }
        const signedOut = this.Config.Paths.SignedOut
        return signedOut === undefined ? undefined : this.Url(signedOut)
    }

    /** A single-use ticket (30 s) for one WebSocket upgrade; it travels as the socket's only subprotocol. */
    public async MintWsTicket(): Promise<string>
    {
        const reply = await this.Post<Record<string, unknown> | undefined>(this.Config.Paths.WsTicket)
        const ticket = reply?.[AppSessionClient.TicketField]
        if (typeof ticket !== 'string' || ticket.length === 0)
        {
            throw new Error(AppSessionClient.NoTicket)
        }
        return ticket
    }

    /** The socket URL of an own-origin route: wss on an https page, ws otherwise. */
    public SocketUrl(route: string, location: IPageLocation): string
    {
        const scheme = location.protocol === AppSessionClient.HttpsProtocol ? AppSessionClient.SecureSocketScheme : AppSessionClient.SocketScheme
        return scheme + location.host + this.Url(route)
    }

    /** An absolute http(s) URL, or an absolute path on the own origin. */
    private static IsDestination(text: string): boolean
    {
        if (text.length > 0 && AppShellConfig.IsOwnOriginPath(text))
        {
            return true
        }
        try
        {
            return AppSessionClient.WebProtocols.has(new URL(text).protocol)
        }
        catch
        {
            return false
        }
    }

    /** Whether the application offers an own-password change. */
    public get ChangesPassword(): boolean
    {
        return this.Config.ChangesPassword
    }

    /** Changes the signed-in subject's own password; the server ends the other sessions and re-issues this one. */
    public async ChangeOwnPassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<PasswordChanged>
    {
        const path = this.Config.Paths.ChangePassword
        if (path === undefined)
        {
            throw new Error(AppSessionClient.NoChangePassword)
        }
        return await this.Post<PasswordChanged>(path, {
            [AppSessionClient.CurrentPasswordField]: currentPassword,
            [AppSessionClient.NewPasswordField]: newPassword,
            [AppSessionClient.ConfirmPasswordField]: confirmPassword,
        })
    }
}
