import type { IncomingMessage } from 'node:http'
import { SessionEndpoint } from '../endpoints/session-endpoint.js'
import type { ISignOutDestination } from '../endpoints/session-endpoint.js'
import type { IOidcClientConfig, IOidcClientProvider } from './oidc-client-config.js'
import type { OidcRelyingParty } from './oidc-relying-party.js'

/** How a sign-out reports and keeps time. */
export interface OidcSignOutDiagnostics
{
    /** Where a failure is reported: a fixed sentence, and the error when there is one (never a token). Default
     *  console.error. */
    Log?: (message: string, err?: unknown) => void
    /** The clock of the discovery-failure backoff; default the system clock. */
    Now?: () => Date
}

export interface OidcSignOutOptions extends OidcSignOutDiagnostics
{
    /** The application's signed-out page, an absolute http(s) URL registered at the IdP as the client's post-logout
     *  redirect URI: sent as `post_logout_redirect_uri`, and where the browser goes when the IdP names no end-session
     *  endpoint. Absent: none is sent (the IdP shows its own signed-out page; logged once) and the fallback is `/`, the
     *  origin root whatever prefix the application is mounted under. */
    PostLogoutRedirectUri?: string
}

/**
 * Where an OIDC application's logout sends the browser (OpenID Connect RP-Initiated Logout 1.0): the issuer's
 * end-session endpoint with the session's stored ID token as `id_token_hint` (the IdP then ends its SSO session at once;
 * without a hint it asks the person to confirm), `client_id`, and `post_logout_redirect_uri` = PostLogoutRedirectUri.
 * The hint leaves the server in the redirect URL, as the specification provides: the browser's history and the IdP's
 * request logs see it. Ending only the local session would not sign anyone out: the next page load would go to the IdP,
 * whose live SSO session signs them straight back in. Without the endpoint (not advertised or not https, discovery
 * failed, the provider refused the request) the answer is the signed-out page; the local session is gone either way.
 *
 * The endpoint is read through the relying party's discovery (the client's HTTP client and CA trust, the discovery
 * cache and its TTL, shared with sign-in). A failed or empty read is not retried for FailureBackoffMs, so sign-outs do
 * not each wait on an unreachable IdP.
 */
export class OidcSignOut implements ISignOutDestination
{
    public static readonly FailureBackoffMs = 60_000
    private static readonly DefaultSignedOutPath = '/'
    private static readonly IdTokenHintParam = 'id_token_hint'
    private static readonly ClientIdParam = 'client_id'
    private static readonly PostLogoutParam = 'post_logout_redirect_uri'
    private static readonly WebProtocols: ReadonlySet<string> = new Set(['https:', 'http:'])
    private static readonly BadPostLogoutMessage = 'OidcSignOut: PostLogoutRedirectUri must be an absolute http(s) URL: '
    private static readonly ClientRefused = 'the OIDC client provider refused the sign-out request; signing out of the application only'
    private static readonly DiscoveryFailed = 'OIDC discovery failed at sign-out; signing out of the application only:'
    private static readonly NoEndSession = 'the issuer names no https end_session_endpoint; signing out of the application only'
    private static readonly NoPostLogout = 'OidcSignOut: no PostLogoutRedirectUri is set; the IdP keeps a signed-out browser on its own page'

    public readonly SignedOut: string
    // When each discovery URL last failed to name an end-session endpoint.
    private readonly failedAt = new Map<string, number>()
    private readonly log: (message: string, err?: unknown) => void
    private readonly now: () => Date
    private reportedNoPostLogout = false

    public constructor(private readonly rp: OidcRelyingParty, private readonly clients: IOidcClientProvider, private readonly options: OidcSignOutOptions = {})
    {
        const uri = options.PostLogoutRedirectUri
        if (uri !== undefined && !OidcSignOut.IsWebUrl(uri))
        {
            throw new Error(OidcSignOut.BadPostLogoutMessage + JSON.stringify(uri))
        }
        this.SignedOut = uri ?? OidcSignOut.DefaultSignedOutPath
        this.log = options.Log ?? SessionEndpoint.ConsoleLog
        this.now = options.Now ?? (() => new Date())
    }

    public async For(req: IncomingMessage, idToken: string | undefined): Promise<string>
    {
        const S = OidcSignOut
        let client: IOidcClientConfig
        try
        {
            client = await this.clients.ClientFor(req)
        }
        catch
        {
            this.log(S.ClientRefused)
            return this.SignedOut
        }
        const endpoint = await this.EndSessionOf(client)
        if (endpoint === undefined)
        {
            return this.SignedOut
        }
        const url = new URL(endpoint)
        if (idToken !== undefined)
        {
            url.searchParams.set(S.IdTokenHintParam, idToken)
        }
        url.searchParams.set(S.ClientIdParam, client.ClientId)
        if (this.options.PostLogoutRedirectUri !== undefined)
        {
            url.searchParams.set(S.PostLogoutParam, this.options.PostLogoutRedirectUri)
        }
        else if (!this.reportedNoPostLogout)
        {
            this.reportedNoPostLogout = true
            this.log(S.NoPostLogout)
        }
        return url.toString()
    }

    private async EndSessionOf(client: IOidcClientConfig): Promise<string | undefined>
    {
        const S = OidcSignOut
        const now = this.now().getTime()
        const failed = this.failedAt.get(client.DiscoveryUrl)
        if (failed !== undefined && now - failed < S.FailureBackoffMs)
        {
            return undefined
        }
        let endpoint: string | undefined
        try
        {
            endpoint = await this.rp.EndSessionEndpoint(client)
        }
        catch (err)
        {
            this.failedAt.set(client.DiscoveryUrl, now)
            this.log(S.DiscoveryFailed, err)
            return undefined
        }
        if (endpoint === undefined)
        {
            this.failedAt.set(client.DiscoveryUrl, now)
            this.log(S.NoEndSession)
            return undefined
        }
        this.failedAt.delete(client.DiscoveryUrl)
        return endpoint
    }

    private static IsWebUrl(text: string): boolean
    {
        try
        {
            return OidcSignOut.WebProtocols.has(new URL(text).protocol)
        }
        catch
        {
            return false
        }
    }
}
