import type { IncomingMessage } from 'node:http'
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { SessionClaims } from '../session/session-claims.js'

/** One OIDC client the application signs people in under, at its realm's sign-in service. */
export interface IOidcClientConfig
{
    /** The issuer the id token must carry. */
    Issuer: string
    /** The discovery document (may sit on an internal origin while the issuer is the browser-facing one). */
    DiscoveryUrl: string
    ClientId: string
    /** The callback the authorize request and the code exchange carry (registered at the IdP). */
    RedirectUri: string
    /** Default `openid email profile`. */
    Scopes?: readonly string[]
    /** Claims the ID token must carry besides the ones always checked (e.g. `iat`, `email`); a token without one is
     *  refused. Default none. */
    RequiredClaims?: readonly string[]
    /** A confidential client's secret; absent for a public (PKCE-only) client. Never logged or echoed. */
    ClientSecret?: string
    /** Session claim <- id-token claim; default `email <- email`. */
    ClaimsMapping?: ReadonlyMap<string, string>
    /** The id-token array claim holding the subject's tenant roles; default `roles`. */
    RolesClaim?: string
    /** The application's name as its realm knows it (its component name): the session keeps this application's roles
     *  from the id token's `app_roles` claim. Absent: the session carries no application roles. */
    Application?: string
    /** Claims every session of this client carries (e.g. the tenant whose realm signed the subject in). */
    FixedClaims?: SessionClaims
    /** The HTTP client for discovery, keys and the code exchange (e.g. a CaTrustingHttpClient); default the relying
     *  party's (or one trusting CaBundleFile). */
    Http?: IHttpClient
    /** A PEM CA bundle file (from a secret or config file) trusted besides the public roots for this client's realm: a
     *  realm on a private CA. Ignored when Http is given. */
    CaBundleFile?: string
}

/**
 * The application-supplied source of the client a sign-in runs under: it resolves the realm from the request (the
 * tenant admin console from its host, the personal cabinet the central login) and owns the client's registration at the
 * IdP (registering it, rotating its secret). Throwing refuses the sign-in.
 */
export interface IOidcClientProvider
{
    ClientFor(req: IncomingMessage): Promise<IOidcClientConfig>
}
