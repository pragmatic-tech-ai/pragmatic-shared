import { createHash } from 'node:crypto'
import { SessionClaims, SessionPolicy, SessionRecord } from '@pragmatic-tech-ai/pragmatic-app-host'
import { RealmTokenVerifier, TokenVerifierUnavailableError, type IRealmTokenVerifier, type RealmTokenPrincipal } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { DesktopRealmSignIn, type DesktopRealm, type IDesktopRealmDirectory } from './desktop-realm-sign-in.js'
import type { IPrincipalConnections } from './tenant-principal-sessions.js'
import { TenantOidcClients } from './tenant-oidc-clients.js'
import { TenantSessionClaims, TenantSessionKind, type TenantSession } from './tenant-sessions.js'

/** Builds the verifier of a tenant's realm (tests swap the clock or the verifier). */
export type RealmVerifierFactory = (realm: DesktopRealm) => IRealmTokenVerifier

/** The realm bearers a desktop gate takes besides its stored sessions (RealmDesktopBearer). */
export interface IDesktopRealmBearer
{
    /** The session a realm access token stands for, or null; throws TokenVerifierUnavailableError when it cannot decide. */
    SessionOf(token: string): Promise<SessionRecord | null>
    /** Ends a realm session here: its tokens are refused from now on (a sign-out). */
    EndSession(session: TenantSession): void
}

/** Overrides of the realm bearer's defaults (tests: a clock, a verifier). */
export interface RealmDesktopBearerOptions
{
    readonly VerifierFor?: RealmVerifierFactory
    readonly NowMs?: () => number
}

/**
 * A realm access token as the desktop bearer (E spec S5): what Plexus presents after it signed in at the tenant's realm
 * as the seeded public client `plexus`. The tenant is the console's own (the in-hive console), or, on the platform's
 * co-hosted tenant plane, the realm the token names (`iss` `<base>/realms/<tenant>`, read unverified only to pick which
 * realm checks it). The token is then checked with `RealmTokenVerifier` against that tenant's realm (the issuer exactly,
 * keys from its discovery over the internal origin), audience `pragmatic-tenant-admin`, authorized party `plexus`,
 * header `typ` `at+jwt` (an ID token is never a bearer), 60 s skew on `iat` / `nbf`, `sid` required, and `exp` still
 * ahead (no skew: a relay must not open past it).
 *
 * It answers the desktop session record the gate admits like a stored one (TenantSessionRules: tenant alive and of its
 * incarnation, roles bridged): subject the realm account, the tenant, the email, kind desktop, the `roles` and this
 * application's `app_roles` the token carries, issued at `iat` and expiring at `exp`. Its id is a digest of the tenant,
 * `sub` and `sid`: the same for every token of one desktop sign-in (one refresh family), different for another, so a
 * relay ends at the token's `exp` and a sign-out closes the relays of that sign-in only. The incarnation check rests on
 * `iat`, which a refresh renews: that holds because a tenant's realm, and its refresh families, end with the tenant.
 *
 * Nothing about a realm session is stored, so what ends one here is kept in process until its tokens expire: a sign-out
 * (`EndSession`: every token of that `sub` + `sid`) and an Owner reset or tenant end (`ClosePrincipal`, `CloseTenant`,
 * as an IPrincipalConnections: every token issued until then). A tenant whose realm cannot be reached (no IdP connection,
 * or its keys unreachable) makes it throw TokenVerifierUnavailableError: the routes answer 503, never a sign-out. The
 * token is never logged.
 */
export class RealmDesktopBearer implements IDesktopRealmBearer, IPrincipalConnections
{
    public static readonly Audience = TenantOidcClients.Application
    public static readonly AuthorizedParty = DesktopRealmSignIn.PlexusClientId
    public static readonly AccessTokenType = 'at+jwt'
    public static readonly SkewSeconds = 60
    /** How long a reset is remembered: the longest access token lifetime a realm may set (60 minutes) and the skew. */
    public static readonly ResetMemoryMs = 61 * 60 * 1000
    /** The prefix of a realm bearer's session id (a stored session's id is a bare digest). */
    public static readonly IdPrefix = 'realm:'
    private static readonly SidClaim = 'sid'
    private static readonly ExpClaim = 'exp'
    private static readonly IatClaim = 'iat'
    private static readonly IssClaim = 'iss'
    private static readonly RequiredClaims: readonly string[] = [RealmDesktopBearer.SidClaim]
    private static readonly JwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    /** The realm segment of an issuer (pragmatic-identity RealmIssuer: `<base>/realms/<realm>`). */
    private static readonly RealmOfIssuer = /\/realms\/([^/?#]+)$/
    private static readonly PayloadIndex = 1
    private static readonly JwsSeparator = '.'
    private static readonly Base64Url = 'base64url'
    private static readonly Utf8 = 'utf8'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HexEncoding = 'hex'
    private static readonly MsPerSecond = 1000
    private static readonly NoValue = ''
    private static readonly UnreachableRealm = 'the tenant realm has no IdP connection'

    /** One verifier per tenant and realm address (its key and discovery caches); a moved IdP gets a new one. */
    private readonly verifiers = new Map<string, { key: string; verifier: IRealmTokenVerifier }>()
    /** Signed-out realm sessions: id -> until when its tokens can live (exp of the token signed out with, plus skew). */
    private readonly ended = new Map<string, number>()
    /** Reset principals and ended tenants: key -> when; a token issued until then is refused. */
    private readonly resets = new Map<string, number>()
    private readonly verifierFor: RealmVerifierFactory
    private readonly nowMs: () => number

    public constructor(
        private readonly realms: IDesktopRealmDirectory,
        /** The console's one tenant (the in-hive console); absent, the tenant is the realm the token names. */
        private readonly tenantId?: string,
        options: RealmDesktopBearerOptions = {})
    {
        this.verifierFor = options.VerifierFor ?? (realm => RealmDesktopBearer.VerifierOf(realm))
        this.nowMs = options.NowMs ?? Date.now
    }

    /** Whether a bearer is shaped as a JWS compact token (three segments); a stored desktop session token is not. */
    public static IsJwt(token: string): boolean
    {
        return RealmDesktopBearer.JwsPattern.test(token)
    }

    /** The verifier a console checks one realm's bearers with. */
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

    /** The session id of a desktop sign-in at a realm: `realm:` and the digest of its tenant, subject and refresh family. */
    public static IdOf(tenantId: string, subject: string, sid: string): string
    {
        const R = RealmDesktopBearer
        return R.IdPrefix + createHash(R.HashAlgorithm).update(JSON.stringify([tenantId, subject, sid])).digest(R.HexEncoding)
    }

    /** The realm (tenant) an unverified token names in its `iss`, or undefined when it names none. */
    public static TenantNamedBy(token: string): string | undefined
    {
        const R = RealmDesktopBearer
        try
        {
            const payload: unknown = JSON.parse(Buffer.from(token.split(R.JwsSeparator)[R.PayloadIndex] ?? R.NoValue, R.Base64Url).toString(R.Utf8))
            const iss = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[R.IssClaim] : undefined
            const match = typeof iss === 'string' ? R.RealmOfIssuer.exec(iss) : null
            return match === null ? undefined : decodeURIComponent(match[1] as string)
        }
        catch
        {
            return undefined
        }
    }

    public async SessionOf(token: string): Promise<SessionRecord | null>
    {
        if (!RealmDesktopBearer.IsJwt(token))
        {
            return null
        }
        const tenantId = this.tenantId ?? RealmDesktopBearer.TenantNamedBy(token)
        const realm = tenantId === undefined ? undefined : this.realms.For(tenantId)
        if (tenantId === undefined || realm === undefined)
        {
            return null
        }
        const principal = await (await this.Verifier(tenantId, realm)).Verify(token)
        const record = principal === undefined ? null : this.RecordOf(tenantId, principal)
        return record === null || this.IsEnded(record, tenantId) ? null : record
    }

    public EndSession(session: TenantSession): void
    {
        const now = this.nowMs()
        this.Prune(now)
        this.ended.set(session.id, Date.parse(session.expiresAt) + RealmDesktopBearer.SkewSeconds * RealmDesktopBearer.MsPerSecond)
    }

    /** An Owner reset: every realm token of the principal issued until now is refused. Closes nothing itself (0). */
    public ClosePrincipal(tenantId: string, principalId: string): number
    {
        this.Reset(RealmDesktopBearer.PrincipalKey(tenantId, principalId))
        return 0
    }

    /** The tenant ended: every realm token of the tenant issued until now is refused. Closes nothing itself (0). */
    public CloseTenant(tenantId: string): number
    {
        this.Reset(RealmDesktopBearer.TenantKey(tenantId))
        return 0
    }

    private Reset(key: string): void
    {
        const now = this.nowMs()
        this.Prune(now)
        this.resets.set(key, now)
    }

    private IsEnded(record: SessionRecord, tenantId: string): boolean
    {
        const R = RealmDesktopBearer
        const issuedMs = record.IssuedAt.getTime()
        const principalReset = this.resets.get(R.PrincipalKey(tenantId, record.Subject))
        const tenantReset = this.resets.get(R.TenantKey(tenantId))
        return this.ended.has(record.Id)
            || (principalReset !== undefined && issuedMs <= principalReset)
            || (tenantReset !== undefined && issuedMs <= tenantReset)
    }

    /** Forgets what no token can outlive any more. */
    private Prune(now: number): void
    {
        for (const [id, until] of this.ended)
        {
            if (until <= now)
            {
                this.ended.delete(id)
            }
        }
        for (const [key, at] of this.resets)
        {
            if (at + RealmDesktopBearer.ResetMemoryMs <= now)
            {
                this.resets.delete(key)
            }
        }
    }

    private async Verifier(tenantId: string, tenant: { Realm(): Promise<DesktopRealm | undefined> }): Promise<IRealmTokenVerifier>
    {
        const realm = await tenant.Realm()
        if (realm === undefined)
        {
            throw new TokenVerifierUnavailableError(RealmDesktopBearer.UnreachableRealm)
        }
        const known = this.verifiers.get(tenantId)
        if (known !== undefined && known.key === realm.Key)
        {
            return known.verifier
        }
        const verifier = this.verifierFor(realm)
        this.verifiers.set(tenantId, { key: realm.Key, verifier })
        return verifier
    }

    private RecordOf(tenantId: string, principal: RealmTokenPrincipal): SessionRecord | null
    {
        const R = RealmDesktopBearer
        const sid = principal.Claims[R.SidClaim]
        const exp = principal.Claims[R.ExpClaim]
        const iat = principal.Claims[R.IatClaim]
        if (typeof sid !== 'string' || sid.length === 0 || typeof exp !== 'number' || typeof iat !== 'number' || exp * R.MsPerSecond <= this.nowMs())
        {
            return null
        }
        const values: Record<string, string | readonly string[]> = {
            [TenantSessionClaims.TenantClaim]: tenantId,
            [TenantSessionClaims.KindClaim]: TenantSessionKind.Desktop,
            [TenantSessionClaims.RolesClaim]: principal.Roles.TenantRoles,
            [TenantSessionClaims.AppRolesClaim]: principal.Roles.RolesOf(R.Audience),
        }
        // The email as the realm states it, as a stored session's (the realm is the tenant's own sign-in service).
        if (principal.Email !== undefined)
        {
            values[TenantSessionClaims.EmailClaim] = principal.Email
        }
        const issuedAt = new Date(iat * R.MsPerSecond)
        const expiresAt = new Date(exp * R.MsPerSecond)
        const lifetime = Math.max(0, expiresAt.getTime() - issuedAt.getTime())
        return new SessionRecord(R.IdOf(tenantId, principal.Subject, sid), principal.Subject, SessionClaims.From(values), issuedAt, expiresAt, issuedAt, new SessionPolicy(lifetime))
    }

    private static PrincipalKey(tenantId: string, principalId: string): string
    {
        return JSON.stringify([tenantId, principalId])
    }

    private static TenantKey(tenantId: string): string
    {
        return JSON.stringify([tenantId])
    }
}
