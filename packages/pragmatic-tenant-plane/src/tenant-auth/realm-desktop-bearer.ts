import { createHash } from 'node:crypto'
import { SessionClaims, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { RealmTokenVerifier, type IRealmTokenVerifier, type RealmTokenPrincipal } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { DesktopRealm, IDesktopRealmSource } from './desktop-realm-sign-in.js'
import { TenantOidcClients } from './tenant-oidc-clients.js'
import { TenantSessionClaims, TenantSessionKind } from './tenant-sessions.js'

/** Builds the verifier of the console's realm (tests swap the clock or the verifier). */
export type RealmVerifierFactory = (realm: DesktopRealm) => IRealmTokenVerifier

/**
 * A realm access token as the desktop bearer (E spec S5): what Plexus presents after it signed in at the console's realm
 * as the seeded public client `plexus`. The token is checked with `RealmTokenVerifier` against the console's realm (the
 * issuer exactly, keys from its discovery over the internal origin), audience `pragmatic-tenant-admin`, authorized party
 * `plexus`, header `typ` `at+jwt` (an ID token is never a bearer), 60 s skew, and `sid` and `exp` required. It answers
 * the desktop session record the gate admits like a stored one (TenantSessionRules: tenant alive and of its
 * incarnation, roles bridged): subject the realm account, the console's tenant, the email, kind desktop, the `roles` and
 * this application's `app_roles` the token carries, issued at `iat` and expiring at `exp`. Its id is a digest of `sub`
 * and `sid`, the same for every token of one desktop sign-in (one refresh family) and different for another, so a
 * sign-out closes the relays of that sign-in only, and a relay ends at the token's `exp`. The token is never logged.
 */
export class RealmDesktopBearer
{
    public static readonly Audience = TenantOidcClients.Application
    public static readonly AuthorizedParty = 'plexus'
    public static readonly AccessTokenType = 'at+jwt'
    public static readonly SkewSeconds = 60
    /** The prefix of a realm bearer's session id (a stored session's id is a bare digest). */
    public static readonly IdPrefix = 'realm:'
    private static readonly SidClaim = 'sid'
    private static readonly ExpClaim = 'exp'
    private static readonly IatClaim = 'iat'
    private static readonly RequiredClaims: readonly string[] = [RealmDesktopBearer.SidClaim, RealmDesktopBearer.ExpClaim]
    private static readonly JwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly IdSeparator = '\n'
    private static readonly MsPerSecond = 1000

    private verifier: { key: string; verifier: IRealmTokenVerifier } | undefined

    public constructor(
        private readonly realms: IDesktopRealmSource,
        private readonly tenantId: string,
        private readonly verifierFor: RealmVerifierFactory = realm => RealmDesktopBearer.VerifierOf(realm))
    {
    }

    /** Whether a bearer is shaped as a JWS compact token (three segments); a stored desktop session token is not. */
    public static IsJwt(token: string): boolean
    {
        return RealmDesktopBearer.JwsPattern.test(token)
    }

    /** The verifier the console checks realm bearers with. */
    public static VerifierOf(realm: DesktopRealm, now?: () => Date): IRealmTokenVerifier
    {
        const R = RealmDesktopBearer
        return new RealmTokenVerifier({
            Issuer: realm.Issuer,
            DiscoveryUrl: realm.DiscoveryUrl,
            Http: realm.Http,
            Audience: [R.Audience],
            AuthorizedParties: [R.AuthorizedParty],
            Type: R.AccessTokenType,
            ClockSkewSeconds: R.SkewSeconds,
            RequiredClaims: R.RequiredClaims,
            Now: now,
        })
    }

    /** The session one realm access token stands for, or null when it is not a valid one of the console's realm. */
    public async SessionOf(token: string): Promise<SessionRecord | null>
    {
        if (!RealmDesktopBearer.IsJwt(token))
        {
            return null
        }
        const verifier = await this.Verifier()
        if (verifier === undefined)
        {
            return null
        }
        const principal = await verifier.Verify(token)
        return principal === undefined ? null : this.RecordOf(principal)
    }

    private async Verifier(): Promise<IRealmTokenVerifier | undefined>
    {
        const realm = await this.realms.Realm()
        if (realm === undefined)
        {
            return undefined
        }
        // One verifier per realm address (its key and discovery caches); a moved IdP gets a new one.
        const key = realm.Issuer + RealmDesktopBearer.IdSeparator + realm.DiscoveryUrl
        if (this.verifier === undefined || this.verifier.key !== key)
        {
            this.verifier = { key, verifier: this.verifierFor(realm) }
        }
        return this.verifier.verifier
    }

    private RecordOf(principal: RealmTokenPrincipal): SessionRecord | null
    {
        const R = RealmDesktopBearer
        const sid = principal.Claims[R.SidClaim]
        const exp = principal.Claims[R.ExpClaim]
        const iat = principal.Claims[R.IatClaim]
        if (typeof sid !== 'string' || sid.length === 0 || typeof exp !== 'number' || typeof iat !== 'number')
        {
            return null
        }
        const values: Record<string, string | readonly string[]> = {
            [TenantSessionClaims.TenantClaim]: this.tenantId,
            [TenantSessionClaims.KindClaim]: TenantSessionKind.Desktop,
            [TenantSessionClaims.RolesClaim]: principal.Roles.TenantRoles,
            [TenantSessionClaims.AppRolesClaim]: principal.Roles.RolesOf(R.Audience),
        }
        if (principal.Email !== undefined)
        {
            values[TenantSessionClaims.EmailClaim] = principal.Email
        }
        const issuedAt = new Date(iat * R.MsPerSecond)
        const expiresAt = new Date(exp * R.MsPerSecond)
        const lifetime = Math.max(0, expiresAt.getTime() - issuedAt.getTime())
        return new SessionRecord(R.IdOf(principal.Subject, sid), principal.Subject, SessionClaims.From(values), issuedAt, expiresAt, issuedAt, new SessionPolicy(lifetime))
    }

    /** The session id of a desktop sign-in at the realm: `realm:` and the digest of its subject and refresh family. */
    public static IdOf(subject: string, sid: string): string
    {
        const R = RealmDesktopBearer
        return R.IdPrefix + createHash(R.HashAlgorithm).update(subject + R.IdSeparator + sid).digest(R.HexEncoding)
    }
}
