import type { ServerResponse } from 'node:http'

export interface SecurityHeadersOptions
{
    ContentSecurityPolicy?: string
    ReferrerPolicy?: string
}

/**
 * The headers every response of an application carries: a Content-Security-Policy (default: own origin only, inline
 * styles allowed for the Mural index, no eval, no plugins, never framed), `X-Content-Type-Options: nosniff`,
 * `X-Frame-Options: DENY` for browsers that predate frame-ancestors, and a Referrer-Policy (default no-referrer).
 */
export class SecurityHeaders
{
    public static readonly DefaultContentSecurityPolicy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; ')
    private static readonly DefaultReferrerPolicy = 'no-referrer'
    private static readonly CspHeader = 'Content-Security-Policy'
    private static readonly NoSniffHeader = 'X-Content-Type-Options'
    private static readonly NoSniff = 'nosniff'
    private static readonly FrameOptionsHeader = 'X-Frame-Options'
    private static readonly FrameDeny = 'DENY'
    private static readonly ReferrerPolicyHeader = 'Referrer-Policy'

    private readonly contentSecurityPolicy: string
    private readonly referrerPolicy: string

    public constructor(options: SecurityHeadersOptions = {})
    {
        this.contentSecurityPolicy = options.ContentSecurityPolicy ?? SecurityHeaders.DefaultContentSecurityPolicy
        this.referrerPolicy = options.ReferrerPolicy ?? SecurityHeaders.DefaultReferrerPolicy
    }

    public Apply(res: ServerResponse): void
    {
        res.setHeader(SecurityHeaders.CspHeader, this.contentSecurityPolicy)
        res.setHeader(SecurityHeaders.NoSniffHeader, SecurityHeaders.NoSniff)
        res.setHeader(SecurityHeaders.FrameOptionsHeader, SecurityHeaders.FrameDeny)
        res.setHeader(SecurityHeaders.ReferrerPolicyHeader, this.referrerPolicy)
    }
}
