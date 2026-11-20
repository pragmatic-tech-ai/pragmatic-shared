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
    /** Default Strict. */
    SameSite?: SameSiteMode
    /** Default `/`. */
    Path?: string
    Now?: () => number
}

/**
 * The session cookie: `<name>=<token>; HttpOnly; SameSite=<mode>; Path=<path>; Max-Age=<s>[; Secure]`. The token is
 * a secret: never log or echo it. Read accepts exactly one cookie of the name whose value is base64url; a duplicated
 * one (a planted second cookie) or a malformed value reads as none.
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
    private readonly sameSite: SameSiteMode
    private readonly path: string
    private readonly now: () => number

    public constructor(options: SessionCookieOptions = {})
    {
        this.Name = options.Name ?? SessionCookie.DefaultName
        this.secure = options.Secure ?? true
        this.sameSite = options.SameSite ?? SameSiteMode.Strict
        this.path = options.Path ?? SessionCookie.DefaultPath
        this.now = options.Now ?? Date.now
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
            SessionCookie.SameSitePrefix + this.sameSite,
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
