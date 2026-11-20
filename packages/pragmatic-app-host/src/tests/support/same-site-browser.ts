import { SameSiteMode } from '../../session/session-cookie.js'

/** One cookie as a browser keeps it. */
class JarCookie
{
    public constructor(public readonly Name: string, public readonly Value: string, public readonly SameSite: SameSiteMode)
    {
    }
}

/** How a request came about, which is what SameSite judges. */
export enum NavigationKind
{
    /** A top-level navigation (link, redirect, address bar). */
    TopLevel = 'top-level',
    /** A subresource or script request (fetch, img, a form posted into a frame). */
    Subresource = 'subresource',
}

/**
 * The SameSite rules of RFC 6265bis (5.2, 5.8.3) as a browser applies them to one site's cookies, enough to test a
 * sign-in's flow semantics without a real browser: a request is same-site only when its initiator and every redirect
 * hop before it were on the site; a Strict cookie goes only on same-site requests; a Lax cookie also goes on a
 * cross-site top-level navigation with a safe method (GET/HEAD).
 */
export class SameSiteBrowser
{
    private static readonly SafeMethods: ReadonlySet<string> = new Set(['GET', 'HEAD'])
    private static readonly SameSitePattern = /;\s*SameSite=(Strict|Lax|None)/i
    private static readonly MaxAgeZero = /;\s*Max-Age=0(;|$)/i
    private static readonly LaxName = 'lax'
    private static readonly PairSeparator = ';'
    private static readonly Equals = '='
    private static readonly CookieSeparator = '; '

    private readonly jar = new Map<string, JarCookie>()

    /** Stores the cookie a Set-Cookie header names (a Max-Age=0 one removes it). */
    public Store(setCookie: string): void
    {
        const B = SameSiteBrowser
        const pair = setCookie.split(B.PairSeparator)[0] as string
        const index = pair.indexOf(B.Equals)
        const name = pair.slice(0, index).trim()
        if (B.MaxAgeZero.test(setCookie))
        {
            this.jar.delete(name)
            return
        }
        const mode = B.SameSitePattern.exec(setCookie)?.[1]?.toLowerCase() === B.LaxName ? SameSiteMode.Lax : SameSiteMode.Strict
        this.jar.set(name, new JarCookie(name, pair.slice(index + 1).trim(), mode))
    }

    /** The Cookie header sent on a request whose chain (initiator, then each redirect hop) is same-site as given. */
    public CookieHeader(method: string, kind: NavigationKind, chainSameSite: readonly boolean[]): string | undefined
    {
        const B = SameSiteBrowser
        const sameSite = chainSameSite.every(hop => hop)
        const laxAllowed = kind === NavigationKind.TopLevel && B.SafeMethods.has(method)
        const sent = [...this.jar.values()].filter(c => sameSite || (c.SameSite === SameSiteMode.Lax && laxAllowed))
        return sent.length === 0 ? undefined : sent.map(c => c.Name + B.Equals + c.Value).join(B.CookieSeparator)
    }
}
