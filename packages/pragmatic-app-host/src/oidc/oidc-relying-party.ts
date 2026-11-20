import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { ClaimArrayGroupStrategy, ClaimsMapper, FetchHttpClient, GenericOidcProfile, JwksCache, OidcAuthenticator, OidcDiscovery, OidcResolvedConfig } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IOidcClientConfig } from './oidc-client-config.js'
import { OidcLoginError } from './oidc-login-error.js'
import { ClientSecretStore } from './client-secret-store.js'
import { SessionClaims } from '../session/session-claims.js'
import { SignedInIdentity } from '../session/signed-in-identity.js'

export interface OidcRelyingPartyOptions
{
    /** The HTTP client of a config that brings none; default fetch (https only). */
    Http?: IHttpClient
    /** The session claim the subject's roles go under; default `roles` (the ClaimsAuthorizer's default). */
    SessionRoleClaim?: string
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
 * mapped claims, its roles and the client's fixed claims. Every failure is a generic OidcLoginError; the code is held
 * only as a transient PresentedSecret, cleared in a finally.
 */
export class OidcRelyingParty
{
    private static readonly PackId = 'app-host-oidc'
    private static readonly DefaultScopes: readonly string[] = ['openid', 'email', 'profile']
    private static readonly DefaultRolesClaim = 'roles'
    private static readonly DefaultSessionRoleClaim = 'roles'
    private static readonly EmailClaim = 'email'
    private static readonly ClientSecretParam = 'client_secret'
    private static readonly DefaultClaimsMapping: ReadonlyMap<string, string> = new Map([[OidcRelyingParty.EmailClaim, OidcRelyingParty.EmailClaim]])

    private readonly http: IHttpClient
    private readonly sessionRoleClaim: string
    private readonly now: (() => Date) | undefined
    private readonly caches = new WeakMap<IHttpClient, OidcCaches>()

    public constructor(private readonly flowStates: IOidcFlowStateStore, options: OidcRelyingPartyOptions = {})
    {
        this.http = options.Http ?? new FetchHttpClient()
        this.sessionRoleClaim = options.SessionRoleClaim ?? OidcRelyingParty.DefaultSessionRoleClaim
        this.now = options.Now
    }

    public async Begin(client: IOidcClientConfig): Promise<{ Url: string, State: string }>
    {
        try
        {
            return await this.Authenticator(client).BeginAuthorization(OidcRelyingParty.RealmOf(client))
        }
        catch (err)
        {
            throw OidcLoginError.From(err)
        }
    }

    public async Complete(client: IOidcClientConfig, code: string, state: string): Promise<SignedInIdentity>
    {
        const presented = new PresentedSecret(code)
        try
        {
            const result = await this.Authenticator(client).Authenticate(new Credential(AuthMethod.Oidc, state), presented, OidcRelyingParty.RealmOf(client))
            if (!(result instanceof AuthenticatedResult))
            {
                throw new OidcLoginError()
            }
            const principal = result.Principal
            const claims: Record<string, string | readonly string[]> = Object.fromEntries(principal.Claims)
            claims[this.sessionRoleClaim] = principal.Groups
            let sessionClaims = SessionClaims.From(claims)
            for (const name of client.FixedClaims?.Names() ?? [])
            {
                sessionClaims = sessionClaims.With(name, client.FixedClaims?.Values(name) ?? [])
            }
            return new SignedInIdentity(principal.Id, sessionClaims)
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

    private Authenticator(client: IOidcClientConfig): OidcAuthenticator
    {
        const http = client.Http ?? this.http
        let caches = this.caches.get(http)
        if (caches === undefined)
        {
            caches = new OidcCaches(http, this.now)
            this.caches.set(http, caches)
        }
        const scopes = client.Scopes ?? OidcRelyingParty.DefaultScopes
        const mapping = client.ClaimsMapping ?? OidcRelyingParty.DefaultClaimsMapping
        const profile = new GenericOidcProfile(client.Issuer, client.DiscoveryUrl, scopes, mapping, new ClaimArrayGroupStrategy(client.RolesClaim ?? OidcRelyingParty.DefaultRolesClaim), OidcRelyingParty.ClientSecretParam)
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
            Resolved: new OidcResolvedConfig(client.DiscoveryUrl, client.Issuer, client.ClientId, client.RedirectUri, scopes, hasSecret ? ClientSecretStore.Reference : null, OidcRelyingParty.ClientSecretParam),
            now: this.now,
        })
    }

    /** The realm the client signs into, named by its issuer. */
    private static RealmOf(client: IOidcClientConfig): Realm
    {
        return new Realm(client.Issuer, RealmKind.Saas, client.Issuer)
    }
}
