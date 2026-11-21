import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Realm, RealmKind, RealmRoleClaims } from '@pragmatic-tech-ai/pragmatic-identity'
import { ClaimsMapper, GenericOidcProfile, JwksCache, OidcAuthenticator, OidcDiscovery, OidcHttpClients, OidcResolvedConfig, OidcSignInOutcome, type IHttpClient, type IOidcFlowStateStore, type OidcBeginOptions, type OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IOidcClientConfig } from './oidc-client-config.js'
import { OidcLoginError } from './oidc-login-error.js'
import { ClientSecretStore } from './client-secret-store.js'
import { SessionClaims } from '../session/session-claims.js'
import { SignedInIdentity } from '../session/signed-in-identity.js'
import { RealmRoleGroupStrategy } from './realm-role-group-strategy.js'

export interface OidcRelyingPartyOptions
{
    /** The HTTP client of a config that brings none; default from CaBundleFile (fetch, https only, when absent). */
    Http?: IHttpClient
    /** A PEM CA bundle file trusted besides the public roots by the default HTTP client: a realm on a private CA. */
    CaBundleFile?: string
    /** The session claim the subject's tenant roles go under; default `roles` (the ClaimsAuthorizer's default). */
    SessionRoleClaim?: string
    /** The session claim this application's roles go under; default `app_roles` (the ClaimsAuthorizer's default). */
    SessionAppRoleClaim?: string
    Now?: () => Date
}

/** The discovery and key caches of one HTTP client (discovery documents for five minutes, keys until a kid misses). */
class OidcCaches
{
    public readonly Discovery: OidcDiscovery
    public readonly Jwks: JwksCache

    public constructor(http: IHttpClient, now: (() => Date) | undefined)
    {
        this.Discovery = new OidcDiscovery(http, now)
        this.Jwks = new JwksCache(http)
    }
}

/**
 * The application as an OIDC relying party of its realm: authorization code flow with PKCE, state and nonce, over
 * pragmatic-identity-source-oidc's primitives (discovery, JWKS, the code exchange and id-token checks). The pending
 * flows live in an IOidcFlowStateStore (SqlOidcFlowStateStore in production, so a sign-in begun on one replica completes
 * on another). Begin answers the authorize URL; Complete exchanges the code and maps the id token to the subject, its
 * mapped claims, its roles and the client's fixed claims. Roles are read as the realm issues them (RealmRoleClaims): the
 * tenant roles into the session's `roles` claim, and this application's roles (client.Application) by bare name into
 * its `app_roles` claim; other applications' roles are not kept. Every failure is a generic OidcLoginError; the code
 * is held only as a transient PresentedSecret, cleared in a finally.
 */
export class OidcRelyingParty
{
    private static readonly PackId = 'app-host-oidc'
    private static readonly DefaultScopes: readonly string[] = ['openid', 'email', 'profile']
    private static readonly EmailClaim = 'email'
    private static readonly ClientSecretParam = 'client_secret'
    private static readonly DefaultClaimsMapping: ReadonlyMap<string, string> = new Map([[OidcRelyingParty.EmailClaim, OidcRelyingParty.EmailClaim]])

    private readonly http: IHttpClient
    private readonly sessionRoleClaim: string
    private readonly sessionAppRoleClaim: string
    private readonly now: (() => Date) | undefined
    private readonly caches = new WeakMap<IHttpClient, OidcCaches>()
    private readonly caClients = new Map<string, IHttpClient>()

    public constructor(private readonly flowStates: IOidcFlowStateStore, options: OidcRelyingPartyOptions = {})
    {
        this.http = options.Http ?? OidcHttpClients.Create(options.CaBundleFile)
        this.sessionRoleClaim = options.SessionRoleClaim ?? RealmRoleClaims.RolesClaim
        this.sessionAppRoleClaim = options.SessionAppRoleClaim ?? RealmRoleClaims.AppRolesClaim
        this.now = options.Now
    }

    /** The authorize URL of a new sign-in; `begin` asks for sign-up, passes a login hint, and carries a return path
     *  (validated by the caller) through the flow state to CompleteWithTokens. */
    public async Begin(client: IOidcClientConfig, begin: OidcBeginOptions = {}): Promise<{ Url: string, State: string }>
    {
        try
        {
            return await this.Authenticator(client).BeginAuthorization(OidcRelyingParty.RealmOf(client), begin)
        }
        catch (err)
        {
            throw OidcLoginError.From(err)
        }
    }

    public async Complete(client: IOidcClientConfig, code: string, state: string): Promise<SignedInIdentity>
    {
        return (await this.CompleteWithTokens(client, code, state)).Result
    }

    /** Complete, also handing back the sign-in's upstream tokens (the verified ID token, the access and refresh tokens
     *  when issued) for an application that retains them (SessionTokenRetention), and the return path the flow was begun
     *  with. */
    public async CompleteWithTokens(client: IOidcClientConfig, code: string, state: string): Promise<OidcSignInOutcome<SignedInIdentity>>
    {
        const presented = new PresentedSecret(code)
        try
        {
            const outcome = await this.Authenticator(client).AuthenticateWithTokens(new Credential(AuthMethod.Oidc, state), presented, OidcRelyingParty.RealmOf(client))
            const result = outcome.Result
            if (!(result instanceof AuthenticatedResult) || outcome.Tokens === null)
            {
                throw new OidcLoginError()
            }
            const principal = result.Principal
            const claims: Record<string, string | readonly string[]> = Object.fromEntries(principal.Claims)
            const roles = RealmRoleClaims.FromQualified(principal.Groups)
            claims[this.sessionRoleClaim] = roles.TenantRoles
            if (client.Application !== undefined)
            {
                claims[this.sessionAppRoleClaim] = roles.RolesOf(client.Application)
            }
            let sessionClaims = SessionClaims.From(claims)
            for (const name of client.FixedClaims?.Names() ?? [])
            {
                sessionClaims = sessionClaims.With(name, client.FixedClaims?.Values(name) ?? [])
            }
            return new OidcSignInOutcome(new SignedInIdentity(principal.Id, sessionClaims), outcome.Tokens, outcome.ReturnPath)
        }
        catch (err)
        {
            throw OidcLoginError.From(err)
        }
        finally
        {
            presented.Clear()
        }
    }

    /** Redeems `refreshToken` for a fresh token set of `subject` under the client; null when the issuer refuses. */
    public async Refresh(client: IOidcClientConfig, refreshToken: string, subject: string): Promise<OidcTokenSet | null>
    {
        return await this.Authenticator(client).Refresh(refreshToken, subject)
    }

    /** The issuer's end-session endpoint (`end_session_endpoint`, https only; RP-Initiated Logout), from its discovery
     *  document (cached with the sign-in's); undefined when not advertised. Rejects when discovery fails. */
    public async EndSessionEndpoint(client: IOidcClientConfig): Promise<string | undefined>
    {
        const caches = this.CachesOf(client)
        return (await caches.Discovery.Endpoints(client.DiscoveryUrl)).EndSessionEndpoint
    }

    private CachesOf(client: IOidcClientConfig): OidcCaches
    {
        const http = this.HttpOf(client)
        let caches = this.caches.get(http)
        if (caches === undefined)
        {
            caches = new OidcCaches(http, this.now)
            this.caches.set(http, caches)
        }
        return caches
    }

    private HttpOf(client: IOidcClientConfig): IHttpClient
    {
        return client.Http ?? (client.CaBundleFile === undefined ? this.http : this.CaClient(client.CaBundleFile))
    }

    private Authenticator(client: IOidcClientConfig): OidcAuthenticator
    {
        const http = this.HttpOf(client)
        const caches = this.CachesOf(client)
        const scopes = client.Scopes ?? OidcRelyingParty.DefaultScopes
        const mapping = client.ClaimsMapping ?? OidcRelyingParty.DefaultClaimsMapping
        const profile = new GenericOidcProfile(client.Issuer, client.DiscoveryUrl, scopes, mapping, new RealmRoleGroupStrategy(client.RolesClaim ?? RealmRoleClaims.RolesClaim), OidcRelyingParty.ClientSecretParam)
        const hasSecret = client.ClientSecret !== undefined && client.ClientSecret.length > 0
        // A public client has no secret reference, so the authenticator never reads the store.
        const secrets = new ClientSecretStore(hasSecret ? client.ClientSecret as string : '')
        return new OidcAuthenticator({
            Http: http,
            Discovery: caches.Discovery,
            Jwks: caches.Jwks,
            FlowStates: this.flowStates,
            Secrets: secrets,
            Claims: new ClaimsMapper(profile),
            Config: new IdentityConfig(OidcRelyingParty.PackId, DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map()),
            Resolved: new OidcResolvedConfig(client.DiscoveryUrl, client.Issuer, client.ClientId, client.RedirectUri, scopes, hasSecret ? ClientSecretStore.Reference : null, OidcRelyingParty.ClientSecretParam, client.RequiredClaims ?? []),
            now: this.now,
        })
    }

    // One CA-trusting client per bundle file, so its discovery and key caches are kept across sign-ins.
    private CaClient(caBundleFile: string): IHttpClient
    {
        let http = this.caClients.get(caBundleFile)
        if (http === undefined)
        {
            http = OidcHttpClients.Create(caBundleFile)
            this.caClients.set(caBundleFile, http)
        }
        return http
    }

    /** The realm the client signs into, named by its issuer. */
    private static RealmOf(client: IOidcClientConfig): Realm
    {
        return new Realm(client.Issuer, RealmKind.Saas, client.Issuer)
    }
}
