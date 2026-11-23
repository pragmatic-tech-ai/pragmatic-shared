import { strict as assert } from 'node:assert'
import type { IncomingMessage } from 'node:http'
import { describe, it } from 'node:test'
import { SignedInIdentity } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { DesktopRealm, DesktopRealmSignIn, DesktopRealms, type IDesktopRealmDirectory, type IDesktopTenantRealm } from '../tenant-auth/desktop-realm-sign-in.js'
import { RealmDesktopBearer } from '../tenant-auth/realm-desktop-bearer.js'
import { TenantSessionClaims, TenantSessionKind, TenantSessions } from '../tenant-auth/tenant-sessions.js'
import { TenantPlaneComposer } from '../tenant-plane-composer.js'

/** The realm's discovery as the console reads it over the internal origin; counts the reads, can fail. */
class ProbeHttp implements IHttpClient
{
    public Reads = 0
    public Down = false

    public constructor(public Document: Record<string, unknown>)
    {
    }

    public async GetJson(url: string): Promise<unknown>
    {
        this.Reads++
        assert.equal(url, SignInFixture.InternalDiscovery)
        if (this.Down)
        {
            throw new Error('unreachable')
        }
        return this.Document
    }

    public async PostForm(): Promise<unknown>
    {
        throw new Error('no posts')
    }
}

class SignInFixture
{
    public static readonly TenantId = 'acme'
    public static readonly OtherTenant = 'globex'
    public static readonly Browser = 'https://idp.acme.example'
    public static readonly Internal = 'https://pragmatic-tenant-idp.acme.svc:7100'
    public static readonly Issuer = 'https://idp.acme.example/realms/acme'
    public static readonly OtherIssuer = 'https://idp.acme.example/realms/globex'
    public static readonly InternalDiscovery = 'https://pragmatic-tenant-idp.acme.svc:7100/realms/acme/.well-known/openid-configuration'
    public static readonly Connection: IdpConnection = { baseUrl: SignInFixture.Internal, browserBaseUrl: SignInFixture.Browser, ca: Buffer.alloc(0), adminToken: 'admin', adminTokenRef: 'ref', caDir: '' }

    public static Document(methods: readonly string[] | undefined, issuer: string = SignInFixture.Issuer): Record<string, unknown>
    {
        return methods === undefined ? { issuer } : { issuer, token_endpoint_auth_methods_supported: methods }
    }
}

/** A movable clock in ms. */
class SignInClock
{
    public Ms = 1_000_000

    public readonly Now = (): number => this.Ms
}

class BearerDirectory implements ITenantDirectory
{
    public readonly Gone = new Set<string>()

    public GetTenant(id: string): TenantRecord | undefined
    {
        const known = id === SignInFixture.TenantId || id === SignInFixture.OtherTenant
        return known && !this.Gone.has(id) ? { id, clientId: 'c1', displayName: id, createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: 'owner-1' } : undefined
    }

    public GetHive(): HiveRecord | undefined
    {
        return undefined
    }

    public ListHives(): readonly HiveRecord[]
    {
        return []
    }
}

/** Two tenants' realms (two fake IdPs) behind one directory. */
class TwoRealms implements IDesktopRealmDirectory
{
    public constructor(private readonly realms: ReadonlyMap<string, DesktopRealm>)
    {
    }

    public For(tenantId: string): IDesktopTenantRealm | undefined
    {
        const realm = this.realms.get(tenantId)
        return realm === undefined ? undefined : { Realm: async () => realm, Advert: async () => undefined }
    }
}

/** A gate over realm bearers of the acme realm (and, for the co-hosted plane, of globex). */
class BearerKit
{
    public static readonly Email = 'ada@acme.example'

    private constructor(
        public readonly Idp: FakeOidcIdp,
        public readonly OtherIdp: FakeOidcIdp,
        public readonly Directory: BearerDirectory,
        public readonly Sessions: TenantSessions,
        public readonly Realms: TwoRealms)
    {
    }

    public static async Create(): Promise<BearerKit>
    {
        const F = SignInFixture
        const idp = await FakeOidcIdp.Create(F.Issuer)
        const other = await FakeOidcIdp.Create(F.OtherIssuer)
        const realms = new TwoRealms(new Map([
            [F.TenantId, new DesktopRealm(F.Issuer, idp.DiscoveryUrl, new FakeOidcHttpClient(idp))],
            [F.OtherTenant, new DesktopRealm(F.OtherIssuer, other.DiscoveryUrl, new FakeOidcHttpClient(other))],
        ]))
        return new BearerKit(idp, other, new BearerDirectory(), new TenantSessions(TenantSessions.InMemory(), false), realms)
    }

    /** The in-hive console's gate (one tenant), or the co-hosted plane's (tenant from the token). */
    public Gate(coHosted: boolean = false): DesktopAuthGate
    {
        return new DesktopAuthGate(this.Sessions.Store, this.Directory, new RealmDesktopBearer(this.Realms, coHosted ? undefined : SignInFixture.TenantId))
    }

    public static Request(token: string): IncomingMessage
    {
        return { headers: { authorization: 'Bearer ' + token } } as unknown as IncomingMessage
    }

    public Access(claims: Record<string, unknown> = {}, expSecondsFromNow: number = 600, idp: FakeOidcIdp = this.Idp): Promise<string>
    {
        return idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', client_id: 'plexus', sid: 'fam-1', email: BearerKit.Email, roles: ['admin'], app_roles: { 'pragmatic-tenant-admin': ['environment-admin'], ledger: ['viewer'] }, ...claims }, { typ: 'at+jwt', expSecondsFromNow })
    }
}

describe('DesktopRealmSignIn: what /desktop/console names (S4)', () =>
{
    const F = SignInFixture

    it('names issuer and plexus once the realm advertises none, read over the internal origin, kept 5 minutes', async () =>
    {
        const clock = new SignInClock()
        const http = new ProbeHttp(F.Document(['client_secret_basic', 'none']))
        const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => F.Connection }, F.TenantId, true, { NowMs: clock.Now, HttpFor: () => http })
        assert.deepEqual(await signIn.Advert(), { issuer: F.Issuer, clientId: 'plexus' })
        clock.Ms += DesktopRealmSignIn.ProbeTtlMs - 1
        await signIn.Advert()
        assert.equal(http.Reads, 1)
        http.Document = F.Document(['client_secret_basic'])
        clock.Ms += 1
        assert.equal(await signIn.Advert(), undefined, 'the probe is asked again after its lifetime')
        assert.equal(http.Reads, 2)
    })

    it('names nothing while the realm does not advertise none, or names another issuer', async () =>
    {
        for (const doc of [F.Document(['client_secret_basic']), F.Document(undefined), F.Document(['none'], 'https://evil.example/realms/acme')])
        {
            const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => F.Connection }, F.TenantId, true, { HttpFor: () => new ProbeHttp(doc) })
            assert.equal(await signIn.Advert(), undefined)
        }
    })

    it('names nothing with the setting off, and does not even probe', async () =>
    {
        const http = new ProbeHttp(F.Document(['none']))
        const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => F.Connection }, F.TenantId, false, { HttpFor: () => http })
        assert.equal(await signIn.Advert(), undefined)
        assert.equal(http.Reads, 0)
    })

    it('a realm that cannot be read names nothing and is asked again after 30 seconds', async () =>
    {
        const clock = new SignInClock()
        const http = new ProbeHttp(F.Document(['none']))
        http.Down = true
        let connection: IdpConnection | undefined
        const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => connection }, F.TenantId, true, { NowMs: clock.Now, HttpFor: () => http })
        assert.equal(await signIn.Advert(), undefined, 'no IdP connection yet')
        connection = F.Connection
        clock.Ms += DesktopRealmSignIn.FailedProbeTtlMs
        assert.equal(await signIn.Advert(), undefined, 'discovery unreachable')
        http.Down = false
        clock.Ms += DesktopRealmSignIn.FailedProbeTtlMs - 1
        assert.equal(await signIn.Advert(), undefined, 'still within the failed probe lifetime')
        clock.Ms += 1
        assert.deepEqual(await signIn.Advert(), { issuer: F.Issuer, clientId: 'plexus' })
    })

    it('the realm is the browser issuer with discovery over the internal origin, its address kept 5 minutes', async () =>
    {
        const clock = new SignInClock()
        let connects = 0
        const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => { connects++; return F.Connection } }, F.TenantId, true, { NowMs: clock.Now, HttpFor: () => new ProbeHttp({}) })
        const realm = await signIn.Realm()
        assert.ok(realm instanceof DesktopRealm)
        assert.equal(realm.Issuer, F.Issuer)
        assert.equal(realm.DiscoveryUrl, F.InternalDiscovery)
        await signIn.Realm()
        assert.equal(connects, 1)
        clock.Ms += DesktopRealmSignIn.ProbeTtlMs
        await signIn.Realm()
        assert.equal(connects, 2)
    })

    it('DesktopRealms keeps one sign-in per known tenant and makes none for an unknown one', () =>
    {
        const realms = new DesktopRealms({ ConnectForTenant: async () => F.Connection }, new BearerDirectory(), true)
        const acme = realms.For(F.TenantId)
        assert.ok(acme !== undefined)
        assert.equal(realms.For(F.TenantId), acme)
        assert.equal(realms.For('nobody'), undefined)
    })

    it('the setting reads on and off, defaults per console, and refuses anything else', () =>
    {
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf(undefined, true), true)
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf(' ', false), false)
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf('off', true), false)
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf('FALSE', true), false)
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf('on', false), true)
        assert.equal(TenantPlaneComposer.DesktopRealmSignInOf('1', false), true)
        assert.throws(() => TenantPlaneComposer.DesktopRealmSignInOf('maybe', true), /PRAGMATIC_TENANT_ADMIN_DESKTOP_REALM_SIGN_IN/)
    })
})

describe('RealmDesktopBearer through DesktopAuthGate (S5)', () =>
{
    const F = SignInFixture

    it('a realm access token is a desktop session of the console\'s tenant, expiring with the token', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = kit.Gate()
        const token = await kit.Access()
        const session = await gate.Principal(BearerKit.Request(token))
        assert.ok(session !== null)
        assert.equal(session.tenantId, F.TenantId)
        assert.equal(session.principalId, 'acct-1')
        assert.equal(session.email, BearerKit.Email)
        assert.equal(session.kind, TenantSessionKind.Desktop)
        assert.deepEqual(session.roles, ['admin'])
        assert.deepEqual(session.appRoles, ['environment-admin'], 'this application\'s roles only')
        const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).exp as number
        assert.equal(session.expiresAt, new Date(exp * 1000).toISOString())
        assert.equal(session.id, RealmDesktopBearer.IdOf(F.TenantId, 'acct-1', 'fam-1'))
        assert.equal(gate.IsRealmBearer(BearerKit.Request(token)), true)
    })

    it('every token of one sign-in is one session id; another sign-in is another', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = kit.Gate()
        const first = await gate.Principal(BearerKit.Request(await kit.Access()))
        const renewed = await gate.Principal(BearerKit.Request(await kit.Access()))
        const other = await gate.Principal(BearerKit.Request(await kit.Access({ sid: 'fam-2' })))
        assert.equal(first?.id, renewed?.id)
        assert.notEqual(first?.id, other?.id)
        assert.ok(first?.id.startsWith(RealmDesktopBearer.IdPrefix))
    })

    it('refuses an ID token, another audience, another client, another realm, a forged key, an expired token, no sid', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = kit.Gate()
        const forger = await FakeOidcIdp.Create(F.Issuer)
        const refused = [
            await kit.Idp.MintIdToken({ sub: 'acct-1', aud: 'plexus', azp: 'plexus', sid: 'fam-1' }),
            await kit.Access({ aud: 'plexus' }),
            await kit.Access({ azp: 'ledger' }),
            await kit.Access({}, 600, kit.OtherIdp),
            await forger.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt' }),
            await kit.Access({}, -120),
            await kit.Access({ sid: undefined }),
            await kit.Access({ sid: '' }),
        ]
        for (const [index, token] of refused.entries())
        {
            assert.equal(await gate.Principal(BearerKit.Request(token)), null, String(index))
        }
    })

    it('a deleted tenant\'s realm token is refused', async () =>
    {
        const kit = await BearerKit.Create()
        const token = await kit.Access()
        kit.Directory.Gone.add(F.TenantId)
        assert.equal(await kit.Gate().Principal(BearerKit.Request(token)), null)
    })

    it('the co-hosted plane takes each tenant\'s token against that tenant\'s realm only', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = kit.Gate(true)
        assert.equal((await gate.Principal(BearerKit.Request(await kit.Access())))?.tenantId, F.TenantId)
        assert.equal((await gate.Principal(BearerKit.Request(await kit.Access({}, 600, kit.OtherIdp))))?.tenantId, F.OtherTenant)
        // A token of acme's realm naming globex's issuer is checked with globex's keys, and fails.
        const swapped = await kit.Idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt', issuer: F.OtherIssuer })
        assert.equal(await gate.Principal(BearerKit.Request(swapped)), null)
        const unknown = await kit.Idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt', issuer: 'https://idp.acme.example/realms/nobody' })
        assert.equal(await gate.Principal(BearerKit.Request(unknown)), null)
        const nowhere = await kit.Idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt', issuer: 'https://idp.acme.example' })
        assert.equal(await gate.Principal(BearerKit.Request(nowhere)), null)
        assert.equal(RealmDesktopBearer.TenantNamedBy('a.b.c'), undefined)
        assert.notEqual((await gate.Principal(BearerKit.Request(await kit.Access())))?.id, (await gate.Principal(BearerKit.Request(await kit.Access({}, 600, kit.OtherIdp))))?.id, 'the session id names the tenant')
    })

    it('the stored desktop session bearer still works; a console session is still no desktop bearer', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = kit.Gate()
        const desktop = await kit.Sessions.IssueDesktop(new SignedInIdentity('acct-1', TenantSessionClaims.Of(F.TenantId, BearerKit.Email)))
        assert.equal((await gate.Principal(BearerKit.Request(desktop.Token)))?.principalId, 'acct-1')
        assert.equal(gate.IsRealmBearer(BearerKit.Request(desktop.Token)), false)
        const console = await kit.Sessions.Store.Issue('acct-1', TenantSessionClaims.Of(F.TenantId, BearerKit.Email))
        assert.equal(await gate.Principal(BearerKit.Request(console.Token)), null)
    })

    it('without realms a JWT-shaped bearer is no session and no realm bearer', async () =>
    {
        const kit = await BearerKit.Create()
        const gate = new DesktopAuthGate(kit.Sessions.Store, kit.Directory)
        const token = await kit.Access()
        assert.equal(await gate.Principal(BearerKit.Request(token)), null)
        assert.equal(gate.IsRealmBearer(BearerKit.Request(token)), false)
    })

    it('one verifier per tenant realm address', async () =>
    {
        const kit = await BearerKit.Create()
        let built = 0
        const bearer = new RealmDesktopBearer(kit.Realms, F.TenantId, {
            VerifierFor: realm =>
            {
                built++
                return RealmDesktopBearer.VerifierOf(realm)
            },
        })
        const token = await kit.Access()
        assert.notEqual(await bearer.SessionOf(token), null)
        assert.notEqual(await bearer.SessionOf(token), null)
        assert.equal(built, 1)
        assert.equal(await bearer.SessionOf('not-a-jwt'), null)
        assert.equal(RealmDesktopBearer.IsJwt('a.b.c'), true)
        assert.equal(RealmDesktopBearer.IsJwt('opaque-session-token'), false)
    })
})
