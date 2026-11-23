import { createHash } from 'node:crypto'
import { CaTrustingHttpClient, type IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { IIdpService } from '../idp-service-contract.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantOidcClients } from './tenant-oidc-clients.js'

/** What `/desktop/console` names for a desktop to sign in at the realm itself (E spec S4): the issuer and the client id. */
export type DesktopSignInAdvert = { issuer: string; clientId: string }

/**
 * A tenant's realm as a desktop bearer is checked against it: the issuer, how its discovery is reached, and `Trust`, a
 * digest of the CA the discovery client trusts (a rotated IdP CA is a different realm address, so a verifier holding
 * the old client is replaced).
 */
export class DesktopRealm
{
    private static readonly NoTrust = ''

    public constructor(public readonly Issuer: string, public readonly DiscoveryUrl: string, public readonly Http: IHttpClient, public readonly Trust: string = DesktopRealm.NoTrust)
    {
        Object.freeze(this)
    }

    /** The key a verifier of this realm is kept under: issuer, discovery and trust. */
    public get Key(): string
    {
        return JSON.stringify([this.Issuer, this.DiscoveryUrl, this.Trust])
    }
}

/** Where a tenant's realm is found: its IdP connection (`IIdpService.ConnectForTenant`). */
export interface IDesktopRealmSource
{
    /** The tenant's realm, or undefined while its IdP is not known (no connection, kept 30 s). */
    Realm(): Promise<DesktopRealm | undefined>
}

/** What names a tenant's realm sign-in in `/desktop/console`. */
export interface IDesktopSignInAdvert
{
    /** `{ issuer, clientId }` when a desktop may sign in at the realm itself; undefined otherwise. */
    Advert(): Promise<DesktopSignInAdvert | undefined>
}

/** One tenant's realm, as the desktop bearer and the console lookup use it. */
export interface IDesktopTenantRealm extends IDesktopRealmSource, IDesktopSignInAdvert
{
}

/** Overrides of the sign-in advert's defaults (tests: a clock, an HTTP client). */
export interface DesktopRealmSignInOptions
{
    readonly NowMs?: () => number
    /** The HTTP client discovery is read with (default: one trusting the IdP connection's CA). */
    readonly HttpFor?: (conn: IdpConnection) => IHttpClient
}

/**
 * A tenant's desktop sign-in at its realm (E spec S4): the realm the console trusts (its own OIDC client's issuer for
 * the tenant, from the tenant's IdP connection: discovery over the internal origin, the issuer the browser-facing one)
 * and whether to name it in `/desktop/console`. It is named when the setting is on (`desktopRealmSignIn`; off withholds
 * it, the live loop's transitional mode) and the realm can serve the seeded public client `plexus`: its discovery names
 * the same issuer and lists `none` among `token_endpoint_auth_methods_supported` (a realm sign-in service from before
 * S1 does not). The probe's answer is kept 5 minutes, a failed probe 30 seconds (its error's name is logged, nothing
 * more); the realm's address (read from the IdP connection, which may read mounted files) is kept 5 minutes, a missing
 * connection 30 seconds. Concurrent askers share one probe and one connection read.
 */
export class DesktopRealmSignIn implements IDesktopTenantRealm
{
    /** The seeded public client every realm serves (pragmatic-tenant-idp `SeededClients`). */
    public static readonly PlexusClientId = 'plexus'
    public static readonly ProbeTtlMs = 5 * 60 * 1000
    public static readonly FailedProbeTtlMs = 30 * 1000
    private static readonly AuthMethodsField = 'token_endpoint_auth_methods_supported'
    private static readonly IssuerField = 'issuer'
    private static readonly NoneMethod = 'none'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly LogPrefix = '[desktop-realm-sign-in] the realm discovery probe failed:'
    private static readonly ConnectLogPrefix = '[desktop-realm-sign-in] the tenant IdP connection could not be read:'

    private readonly nowMs: () => number
    private readonly httpFor: (conn: IdpConnection) => IHttpClient
    private probed: { advert: DesktopSignInAdvert | undefined; untilMs: number } | undefined
    private probing: Promise<DesktopSignInAdvert | undefined> | undefined
    private known: { realm: DesktopRealm | undefined; untilMs: number } | undefined
    private connecting: Promise<DesktopRealm | undefined> | undefined

    public constructor(
        private readonly idp: Pick<IIdpService, 'ConnectForTenant'>,
        private readonly tenantId: string,
        private readonly enabled: boolean,
        options: DesktopRealmSignInOptions = {})
    {
        this.nowMs = options.NowMs ?? Date.now
        this.httpFor = options.HttpFor ?? (conn => new CaTrustingHttpClient(conn.ca))
    }

    public async Realm(): Promise<DesktopRealm | undefined>
    {
        if (this.known !== undefined && this.nowMs() < this.known.untilMs)
        {
            return this.known.realm
        }
        this.connecting ??= this.Connect().finally(() => { this.connecting = undefined })
        return await this.connecting
    }

    /** `{ issuer, clientId }` when a desktop may sign in at the realm; undefined when the setting is off or the realm cannot. */
    public async Advert(): Promise<DesktopSignInAdvert | undefined>
    {
        if (!this.enabled)
        {
            return undefined
        }
        if (this.probed !== undefined && this.nowMs() < this.probed.untilMs)
        {
            return this.probed.advert
        }
        this.probing ??= this.Probe().finally(() => { this.probing = undefined })
        return await this.probing
    }

    /** The realm's address from the IdP connection; a missing or unreadable connection is no realm, kept 30 s. */
    private async Connect(): Promise<DesktopRealm | undefined>
    {
        const D = DesktopRealmSignIn
        const now = this.nowMs()
        let realm: DesktopRealm | undefined
        try
        {
            const conn = await this.idp.ConnectForTenant(this.tenantId)
            realm = conn === undefined ? undefined : new DesktopRealm(TenantOidcClients.IssuerFor(conn, this.tenantId), TenantOidcClients.DiscoveryUrlFor(conn, this.tenantId), this.httpFor(conn),
                createHash(D.HashAlgorithm).update(conn.ca).digest(D.HexEncoding))
        }
        catch (err)
        {
            // Mounted files unreadable, a malformed address: no realm now (callers answer 503). Only the error's name is logged.
            console.error(D.ConnectLogPrefix, err instanceof Error ? err.name : typeof err)
            realm = undefined
        }
        this.known = { realm, untilMs: now + (realm === undefined ? D.FailedProbeTtlMs : D.ProbeTtlMs) }
        return realm
    }

    private async Probe(): Promise<DesktopSignInAdvert | undefined>
    {
        const D = DesktopRealmSignIn
        const now = this.nowMs()
        let advert: DesktopSignInAdvert | undefined
        let failed = false
        try
        {
            const realm = await this.Realm()
            failed = realm === undefined
            advert = realm === undefined ? undefined : D.AdvertOf(realm, await realm.Http.GetJson(realm.DiscoveryUrl))
        }
        catch (err)
        {
            // Unreachable, or not a document: no advert, asked again soon. Only the error's name is logged.
            console.error(D.LogPrefix, err instanceof Error ? err.name : typeof err)
            failed = true
        }
        this.probed = { advert, untilMs: now + (failed ? D.FailedProbeTtlMs : D.ProbeTtlMs) }
        return advert
    }

    /** The advert a discovery document allows: the same issuer and `none` among the token endpoint's methods. */
    private static AdvertOf(realm: DesktopRealm, doc: unknown): DesktopSignInAdvert | undefined
    {
        const D = DesktopRealmSignIn
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

/** The realms desktop bearers and sign-in adverts are checked against, by tenant (DesktopRealms). */
export interface IDesktopRealmDirectory
{
    /** The tenant's realm, or undefined for a tenant this console does not know. */
    For(tenantId: string): IDesktopTenantRealm | undefined
    /** Forgets what is cached for the tenant (it ended; a tenant re-created under the id starts afresh). */
    Forget(tenantId: string): void
}

/**
 * The desktop realm sign-ins of the tenants a console serves: one tenant for the in-hive console, any tenant of its
 * directory for the platform's co-hosted tenant plane. A tenant's entry is made on first use and kept (its probe and
 * address caches); a tenant the directory does not know gets none, so an unknown id never grows the map.
 */
export class DesktopRealms implements IDesktopRealmDirectory
{
    private readonly realms = new Map<string, DesktopRealmSignIn>()

    public constructor(
        private readonly idp: Pick<IIdpService, 'ConnectForTenant'>,
        private readonly tenants: Pick<ITenantDirectory, 'GetTenant'>,
        private readonly enabled: boolean,
        private readonly options: DesktopRealmSignInOptions = {})
    {
    }

    public For(tenantId: string): DesktopRealmSignIn | undefined
    {
        const known = this.realms.get(tenantId)
        if (known !== undefined)
        {
            return known
        }
        if (this.tenants.GetTenant(tenantId) === undefined)
        {
            return undefined
        }
        const signIn = new DesktopRealmSignIn(this.idp, tenantId, this.enabled, this.options)
        this.realms.set(tenantId, signIn)
        return signIn
    }

    public Forget(tenantId: string): void
    {
        this.realms.delete(tenantId)
    }
}
