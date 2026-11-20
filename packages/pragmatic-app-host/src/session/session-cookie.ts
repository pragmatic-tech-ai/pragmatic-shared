/** The cookie's SameSite attribute. */
export enum SameSiteMode
{
    Strict = 'Strict',
    Lax = 'Lax',
}

export interface SessionCookieOptions
{
    /** Default `app_session`. */
    Name?: string
    /** Default true; false only for plain-http local runs. */
    Secure?: boolean
    /** Default Strict, or Lax once an OIDC sign-in surface is registered (AdmitCrossSiteSignIn). Set it to pin a mode. */
    SameSite?: SameSiteMode
    /** Default `/`. */
    Path?: string
    Now?: () => number
}

/**
 * The session cookie: `<name>=<token>; HttpOnly; SameSite=<mode>; Path=<path>; Max-Age=<s>[; Secure]`. The token is
 * a secret: never log or echo it. Read accepts exactly one cookie of the name whose value is base64url; a duplicated
 * one (a planted second cookie) or a malformed value reads as none. SameSite defaults to Strict (password-only
 * applications); an application that signs in through OIDC gets Lax, because the browser returns from the login page
 * through a cross-site redirect chain and a Strict cookie set on the callback is not sent on the navigation that
 * follows it. Lax still keeps the cookie off cross-site subresource requests and cross-site POSTs, and the host's
 * Origin guard refuses every mutation from a foreign Origin either way. A configured mode always wins.
 */
export class SessionCookie
{
    private static readonly DefaultName = 'app_session'
    private static readonly DefaultPath = '/'
    private static readonly TokenPattern = /^[A-Za-z0-9_-]+$/
    private static readonly Equals = '='
    private static readonly PairSeparator = ';'
    private static readonly AttributeSeparator = '; '
    private static readonly HttpOnly = 'HttpOnly'
    private static readonly SameSitePrefix = 'SameSite='
    private static readonly PathPrefix = 'Path='
    private static readonly MaxAgePrefix = 'Max-Age='
    private static readonly SecureAttribute = 'Secure'
    private static readonly MillisPerSecond = 1000
    private static readonly Cleared = 0
    private static readonly BadTokenMessage = 'A session token must be base64url'

    public readonly Name: string
    private readonly secure: boolean
    private readonly configuredSameSite: SameSiteMode | undefined
    private crossSiteSignIn = false
    private readonly path: string
    private readonly now: () => number

    public constructor(options: SessionCookieOptions = {})
    {
        this.Name = options.Name ?? SessionCookie.DefaultName
        this.secure = options.Secure ?? true
        this.configuredSameSite = options.SameSite
        this.path = options.Path ?? SessionCookie.DefaultPath
        this.now = options.Now ?? Date.now
    }

    /** The SameSite mode the cookie is issued with. */
    public get SameSite(): SameSiteMode
    {
        return this.configuredSameSite ?? (this.crossSiteSignIn ? SameSiteMode.Lax : SameSiteMode.Strict)
    }

    /** An OIDC sign-in surface is registered (the callback is a cross-site top-level redirect): the default becomes Lax.
     *  A configured mode stays. */
    public AdmitCrossSiteSignIn(): void
    {
        this.crossSiteSignIn = true
    }

    public Build(token: string, expiresAt: Date): string
    {
        if (!SessionCookie.TokenPattern.test(token))
        {
            throw new Error(SessionCookie.BadTokenMessage)
        }
        const seconds = Math.max(SessionCookie.Cleared, Math.floor((expiresAt.getTime() - this.now()) / SessionCookie.MillisPerSecond))
        return this.Compose(token, seconds)
    }

    public BuildClearing(): string
    {
        return this.Compose('', SessionCookie.Cleared)
    }

    /** The token the Cookie header carries, or null when absent, duplicated or malformed. */
    public Read(cookieHeader: string | undefined): string | null
    {
        if (cookieHeader === undefined)
        {
            return null
        }
        let value: string | null = null
        for (const pair of cookieHeader.split(SessionCookie.PairSeparator))
        {
            const index = pair.indexOf(SessionCookie.Equals)
            if (index < 0 || pair.slice(0, index).trim() !== this.Name)
            {
                continue
            }
            if (value !== null)
            {
                return null
            }
            value = pair.slice(index + 1).trim()
        }
        return value !== null && SessionCookie.TokenPattern.test(value) ? value : null
    }

    private Compose(value: string, maxAge: number): string
    {
        const parts = [
            this.Name + SessionCookie.Equals + value,
            SessionCookie.HttpOnly,
            SessionCookie.SameSitePrefix + this.SameSite,
            SessionCookie.PathPrefix + this.path,
            SessionCookie.MaxAgePrefix + maxAge,
        ]
        if (this.secure)
        {
            parts.push(SessionCookie.SecureAttribute)
        }
        return parts.join(SessionCookie.AttributeSeparator)
    }
}
