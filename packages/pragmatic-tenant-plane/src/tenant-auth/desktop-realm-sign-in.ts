import { CaTrustingHttpClient, type IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { IIdpService } from '../idp-service-contract.js'
import { TenantOidcClients } from './tenant-oidc-clients.js'

/** What `/desktop/console` names for a desktop to sign in at the realm itself (E spec S4): the issuer and the client id. */
export type DesktopSignInAdvert = { issuer: string; clientId: string }

/** The console's own realm as a desktop bearer is checked against it: the issuer, and how its discovery is reached. */
export class DesktopRealm
{
    public constructor(public readonly Issuer: string, public readonly DiscoveryUrl: string, public readonly Http: IHttpClient)
    {
        Object.freeze(this)
    }
}

/** Where the console's realm is found: its IdP connection (`IIdpService.ConnectForTenant`). */
export interface IDesktopRealmSource
{
    /** The console's realm, or undefined while its IdP is not known. */
    Realm(): Promise<DesktopRealm | undefined>
}

/** Overrides of the sign-in advert's defaults (tests: a clock, an HTTP client). */
export interface DesktopRealmSignInOptions
{
    readonly NowMs?: () => number
    /** The HTTP client discovery is read with (default: one trusting the IdP connection's CA). */
    readonly HttpFor?: (conn: IdpConnection) => IHttpClient
}

/**
 * The in-hive console's desktop sign-in at its realm (E spec S4): the realm the console trusts (its own OIDC client's
 * issuer, from its IdP connection: discovery over the internal origin, the issuer the browser-facing one) and whether to
 * name it in `/desktop/console`. It is named when the setting is on (`DesktopRealmSignIn`, default on; off withholds it,
 * the live loop's transitional mode) and the realm can serve the seeded public client `plexus`: its discovery lists
 * `none` among `token_endpoint_auth_methods_supported` (a realm sign-in service from before S1 does not). The probe's
 * answer is kept 5 minutes, a failed probe 30 seconds; the realm's address (read from the IdP connection, which may read
 * mounted files) is kept 5 minutes too.
 */
export class DesktopRealmSignIn implements IDesktopRealmSource
{
    /** The seeded public client every realm serves (pragmatic-tenant-idp `SeededClients`). */
    public static readonly PlexusClientId = 'plexus'
    public static readonly ProbeTtlMs = 5 * 60 * 1000
    public static readonly FailedProbeTtlMs = 30 * 1000
    private static readonly AuthMethodsField = 'token_endpoint_auth_methods_supported'
    private static readonly IssuerField = 'issuer'
    private static readonly NoneMethod = 'none'
    private static readonly NoIdpMessage = 'the console has no IdP connection yet'

    private readonly nowMs: () => number
    private readonly httpFor: (conn: IdpConnection) => IHttpClient
    private probed: { advert: DesktopSignInAdvert | undefined; untilMs: number } | undefined
    private known: { realm: DesktopRealm; untilMs: number } | undefined

    public constructor(
        private readonly idp: Pick<IIdpService, 'ConnectForTenant'>,
        private readonly tenantId: string,
        private readonly enabled: boolean,
        options: DesktopRealmSignInOptions = {})
    {
        this.nowMs = options.NowMs ?? Date.now
        this.httpFor = options.HttpFor ?? (conn => new CaTrustingHttpClient(conn.ca))
    }

    /** Whether the console names its realm's sign-in at all (the setting). */
    public get Enabled(): boolean
    {
        return this.enabled
    }

    public async Realm(): Promise<DesktopRealm | undefined>
    {
        const now = this.nowMs()
        if (this.known !== undefined && now < this.known.untilMs)
        {
            return this.known.realm
        }
        const conn = await this.idp.ConnectForTenant(this.tenantId)
        if (conn === undefined)
        {
            return undefined
        }
        const realm = new DesktopRealm(TenantOidcClients.IssuerFor(conn, this.tenantId), TenantOidcClients.DiscoveryUrlFor(conn, this.tenantId), this.httpFor(conn))
        this.known = { realm, untilMs: now + DesktopRealmSignIn.ProbeTtlMs }
        return realm
    }

    /** `{ issuer, clientId }` when a desktop may sign in at the realm; undefined when the setting is off or the realm cannot. */
    public async Advert(): Promise<DesktopSignInAdvert | undefined>
    {
        if (!this.enabled)
        {
            return undefined
        }
        const now = this.nowMs()
        if (this.probed !== undefined && now < this.probed.untilMs)
        {
            return this.probed.advert
        }
        let advert: DesktopSignInAdvert | undefined
        let ttl = DesktopRealmSignIn.ProbeTtlMs
        try
        {
            advert = await this.Probe()
        }
        catch
        {
            // The IdP is unreachable or answered no document: no advert, asked again soon. No detail is kept.
            advert = undefined
            ttl = DesktopRealmSignIn.FailedProbeTtlMs
        }
        this.probed = { advert, untilMs: now + ttl }
        return advert
    }

    private async Probe(): Promise<DesktopSignInAdvert | undefined>
    {
        const D = DesktopRealmSignIn
        const realm = await this.Realm()
        if (realm === undefined)
        {
            throw new Error(D.NoIdpMessage)
        }
        const doc = await realm.Http.GetJson(realm.DiscoveryUrl)
        if (typeof doc !== 'object' || doc === null)
        {
            return undefined
        }
        const fields = doc as Record<string, unknown>
        const methods = fields[D.AuthMethodsField]
        const servesPublic = Array.isArray(methods) && methods.includes(D.NoneMethod)
        return servesPublic && fields[D.IssuerField] === realm.Issuer ? { issuer: realm.Issuer, clientId: D.PlexusClientId } : undefined
    }
}
