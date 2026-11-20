import { SignInMethod } from './sign-in-method.js'

/** The app-host routes the shell talks to. Every one is an absolute path on the application's own origin. */
export interface AppShellPaths
{
    /** `SessionEndpoint` GET: the subject and claims, 401 without a session. Default `/api/session`. */
    readonly Session: string
    /** `SessionEndpoint` POST: ends the session. Default `/api/logout`. */
    readonly Logout: string
    /** `PasswordLoginEndpoint` POST `{ email, password }`. Default `/api/login`. */
    readonly PasswordLogin: string
    /** `OidcLoginEndpoint` begin: the browser navigates here to sign in. Default `/auth/oidc/begin`. */
    readonly OidcBegin: string
    /** `WsTicketEndpoint` POST: a single-use WebSocket ticket. Default `/api/ws-ticket`. */
    readonly WsTicket: string
    /** The application's own-password change (the host leaves it to each application); undefined: none offered. */
    readonly ChangePassword: string | undefined
}

/** What an application tells the shell about itself. Only the product name is required. */
export interface AppShellOptions
{
    /** Shown on the sign-in page and in the header, e.g. "Platform Admin". */
    readonly ProductName: string
    /** The sign-in methods offered, in display order. Default: OIDC only. */
    readonly SignInMethods?: readonly SignInMethod[]
    /** The prefix the application is mounted under on its origin ('' or `/segment`); prefixes every request. */
    readonly ApiBasePath?: string
    /** Overrides for the app-host routes; the rest keep the host's defaults. */
    readonly Paths?: Partial<AppShellPaths>
    /** Whether a signed-out visitor goes straight to the identity provider. Default: when OIDC is the only method. */
    readonly RedirectWhenSignedOut?: boolean
    /** The server's floor for a new own password, mirrored so Confirm can explain it. Default 12. */
    readonly MinPasswordLength?: number
    /** The session claim that carries the email. Default `email`. */
    readonly EmailClaim?: string
    /** The session claim that carries the tenant roles. Default `roles` (the host's `ClaimsAuthorizer` default). */
    readonly RolesClaim?: string
    /** The session claim that carries this application's roles. Default `app_roles` (the `ClaimsAuthorizer` default). */
    readonly AppRolesClaim?: string
    /** Hide the header's account actions the application does not offer (Change password without a ChangePassword
     *  path, e.g. an OIDC-only application) instead of showing them greyed. Default false: shown, greyed. */
    readonly HideUnofferedActions?: boolean
}

/**
 * The application-specific part of the shell, injected through constructors: product name, sign-in methods, the
 * mount prefix and the host routes. Validated once here, so every request the shell builds stays on its own origin.
 */
export class AppShellConfig
{
    public static readonly DefaultPaths: AppShellPaths = {
        Session: '/api/session',
        Logout: '/api/logout',
        PasswordLogin: '/api/login',
        OidcBegin: '/auth/oidc/begin',
        WsTicket: '/api/ws-ticket',
        ChangePassword: undefined,
    }
    public static readonly DefaultMinPasswordLength = 12
    public static readonly DefaultEmailClaim = 'email'
    public static readonly DefaultRolesClaim = 'roles'
    public static readonly DefaultAppRolesClaim = 'app_roles'
    /** The query parameter and value the host's OidcLoginEndpoint lands a failed sign-in on (its SignInFailedPath,
     *  e.g. `/?sign_in=failed`). */
    public static readonly SignInFailedParam = 'sign_in'
    public static readonly SignInFailedValue = 'failed'

    private static readonly NoBasePath = ''
    private static readonly PathPrefix = '/'
    private static readonly ProtocolRelativePrefix = '//'
    private static readonly Backslash = '\\'
    private static readonly SchemeSeparator = ':'
    private static readonly NoProductName = 'AppShellConfig: a product name is required'
    private static readonly NoSignInMethod = 'AppShellConfig: at least one sign-in method is required'
    private static readonly BadBasePath = 'AppShellConfig: the base path must be empty or an own-origin path prefix like /console: '
    private static readonly BadPath = 'AppShellConfig: a route path must be an absolute own-origin path: '
    private static readonly BadMinLength = 'AppShellConfig: the minimum password length must be at least 1'

    /** Whether the page query `search` carries the failed-sign-in marker. */
    public static IsSignInFailure(search: string): boolean
    {
        return new URLSearchParams(search).get(AppShellConfig.SignInFailedParam) === AppShellConfig.SignInFailedValue
    }

    public readonly ProductName: string
    public readonly SignInMethods: readonly SignInMethod[]
    public readonly ApiBasePath: string
    public readonly Paths: AppShellPaths
    public readonly MinPasswordLength: number
    public readonly EmailClaim: string
    public readonly RolesClaim: string
    public readonly AppRolesClaim: string
    /** Whether the header hides the account actions the application does not offer (rather than greying them). */
    public readonly HidesUnofferedActions: boolean
    private readonly redirect: boolean | undefined

    public constructor(options: AppShellOptions)
    {
        const productName = options.ProductName.trim()
        if (productName.length === 0)
        {
            throw new Error(AppShellConfig.NoProductName)
        }
        const methods = options.SignInMethods ?? [SignInMethod.Oidc]
        if (methods.length === 0)
        {
            throw new Error(AppShellConfig.NoSignInMethod)
        }
        const basePath = options.ApiBasePath ?? AppShellConfig.NoBasePath
        if (!AppShellConfig.IsBasePath(basePath))
        {
            throw new Error(AppShellConfig.BadBasePath + basePath)
        }
        const paths: AppShellPaths = { ...AppShellConfig.DefaultPaths, ...options.Paths }
        for (const path of Object.values(paths))
        {
            if (path !== undefined && !AppShellConfig.IsOwnOriginPath(path))
            {
                throw new Error(AppShellConfig.BadPath + path)
            }
        }
        const minLength = options.MinPasswordLength ?? AppShellConfig.DefaultMinPasswordLength
        if (!Number.isInteger(minLength) || minLength < 1)
        {
            throw new Error(AppShellConfig.BadMinLength)
        }
        this.ProductName = productName
        this.SignInMethods = [...methods]
        this.ApiBasePath = basePath
        this.Paths = Object.freeze(paths)
        this.MinPasswordLength = minLength
        this.EmailClaim = options.EmailClaim ?? AppShellConfig.DefaultEmailClaim
        this.RolesClaim = options.RolesClaim ?? AppShellConfig.DefaultRolesClaim
        this.AppRolesClaim = options.AppRolesClaim ?? AppShellConfig.DefaultAppRolesClaim
        this.HidesUnofferedActions = options.HideUnofferedActions ?? false
        this.redirect = options.RedirectWhenSignedOut
    }

    public Offers(method: SignInMethod): boolean
    {
        return this.SignInMethods.includes(method)
    }

    /** True when a signed-out visitor skips the sign-in page: OIDC is the only method, unless the application says otherwise. */
    public get RedirectsWhenSignedOut(): boolean
    {
        const oidcOnly = this.SignInMethods.length === 1 && this.SignInMethods[0] === SignInMethod.Oidc
        return oidcOnly && this.redirect !== false
    }

    /** Whether the application offers an own-password change (a ChangePassword path is configured). */
    public get ChangesPassword(): boolean
    {
        return this.Paths.ChangePassword !== undefined
    }

    /** An absolute path on this origin: one leading slash, no scheme, no backslash. */
    public static IsOwnOriginPath(path: string): boolean
    {
        return path.startsWith(AppShellConfig.PathPrefix)
            && !path.startsWith(AppShellConfig.ProtocolRelativePrefix)
            && !path.includes(AppShellConfig.Backslash)
            && !path.includes(AppShellConfig.SchemeSeparator)
    }

    private static IsBasePath(path: string): boolean
    {
        if (path === AppShellConfig.NoBasePath)
        {
            return true
        }
        return AppShellConfig.IsOwnOriginPath(path) && !path.endsWith(AppShellConfig.PathPrefix)
    }
}
