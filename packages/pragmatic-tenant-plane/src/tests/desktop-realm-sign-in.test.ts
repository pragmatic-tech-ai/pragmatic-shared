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
import { DesktopRealm, DesktopRealmSignIn } from '../tenant-auth/desktop-realm-sign-in.js'
import { RealmDesktopBearer } from '../tenant-auth/realm-desktop-bearer.js'
import { TenantSessionClaims, TenantSessionKind, TenantSessions } from '../tenant-auth/tenant-sessions.js'

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
    public static readonly Browser = 'https://idp.acme.example'
    public static readonly Internal = 'https://pragmatic-tenant-idp.acme.svc:7100'
    public static readonly Issuer = 'https://idp.acme.example/realms/acme'
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
    public Gone = false

    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === SignInFixture.TenantId && !this.Gone ? { id, clientId: 'c1', displayName: 'Acme', createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: 'owner-1' } : undefined
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
        assert.equal(signIn.Enabled, false)
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

    it('the realm is the browser issuer with discovery over the internal origin', async () =>
    {
        const signIn = new DesktopRealmSignIn({ ConnectForTenant: async () => F.Connection }, F.TenantId, true, { HttpFor: () => new ProbeHttp({}) })
        const realm = await signIn.Realm()
        assert.ok(realm instanceof DesktopRealm)
        assert.equal(realm.Issuer, F.Issuer)
        assert.equal(realm.DiscoveryUrl, F.InternalDiscovery)
    })
})

describe('RealmDesktopBearer through DesktopAuthGate (S5)', () =>
{
    const F = SignInFixture

    async function Kit(): Promise<{ idp: FakeOidcIdp; gate: DesktopAuthGate; directory: BearerDirectory; sessions: TenantSessions }>
    {
        const idp = await FakeOidcIdp.Create(F.Issuer)
        const directory = new BearerDirectory()
        const sessions = new TenantSessions(TenantSessions.InMemory(), false)
        const realm = new DesktopRealm(F.Issuer, idp.DiscoveryUrl, new FakeOidcHttpClient(idp))
        const gate = new DesktopAuthGate(sessions.Store, directory, new RealmDesktopBearer({ Realm: async () => realm }, F.TenantId))
        return { idp, gate, directory, sessions }
    }

    function Request(token: string): IncomingMessage
    {
        return { headers: { authorization: 'Bearer ' + token } } as unknown as IncomingMessage
    }

    function Access(idp: FakeOidcIdp, claims: Record<string, unknown> = {}, expSecondsFromNow: number = 600): Promise<string>
    {
        return idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', client_id: 'plexus', sid: 'fam-1', email: 'ada@acme.example', roles: ['admin'], app_roles: { 'pragmatic-tenant-admin': ['environment-admin'], ledger: ['viewer'] }, ...claims }, { typ: 'at+jwt', expSecondsFromNow })
    }

    it('a realm access token is a desktop session of the console\'s tenant, expiring with the token', async () =>
    {
        const { idp, gate } = await Kit()
        const token = await Access(idp)
        const session = await gate.Principal(Request(token))
        assert.ok(session !== null)
        assert.equal(session.tenantId, F.TenantId)
        assert.equal(session.principalId, 'acct-1')
        assert.equal(session.email, 'ada@acme.example')
        assert.equal(session.kind, TenantSessionKind.Desktop)
        assert.deepEqual(session.roles, ['admin'])
        assert.deepEqual(session.appRoles, ['environment-admin'], 'this application\'s roles only (and the bridge adds none for an admin)')
        const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).exp as number
        assert.equal(session.expiresAt, new Date(exp * 1000).toISOString())
        assert.equal(session.id, RealmDesktopBearer.IdOf('acct-1', 'fam-1'))
        assert.equal(gate.IsRealmBearer(Request(token)), true)
    })

    it('every token of one sign-in is one session id; another sign-in is another', async () =>
    {
        const { idp, gate } = await Kit()
        const first = await gate.Principal(Request(await Access(idp)))
        const renewed = await gate.Principal(Request(await Access(idp)))
        const other = await gate.Principal(Request(await Access(idp, { sid: 'fam-2' })))
        assert.equal(first?.id, renewed?.id)
        assert.notEqual(first?.id, other?.id)
        assert.ok(first?.id.startsWith(RealmDesktopBearer.IdPrefix))
    })

    it('refuses an ID token, another audience, another client, another realm, a forged key, an expired token, no sid', async () =>
    {
        const { idp, gate } = await Kit()
        const forger = await FakeOidcIdp.Create(F.Issuer)
        const refused = [
            await idp.MintIdToken({ sub: 'acct-1', aud: 'plexus', azp: 'plexus', sid: 'fam-1' }),
            await Access(idp, { aud: 'plexus' }),
            await Access(idp, { azp: 'ledger' }),
            await idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt', issuer: 'https://idp.acme.example/realms/globex' }),
            await forger.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt' }),
            await Access(idp, {}, -120),
            await Access(idp, { sid: undefined }),
            await Access(idp, { sid: '' }),
        ]
        for (const [index, token] of refused.entries())
        {
            assert.equal(await gate.Principal(Request(token)), null, String(index))
        }
    })

    it('a deleted tenant\'s realm token is refused', async () =>
    {
        const { idp, gate, directory } = await Kit()
        const token = await Access(idp)
        directory.Gone = true
        assert.equal(await gate.Principal(Request(token)), null)
    })

    it('the stored desktop session bearer still works; a console session is still no desktop bearer', async () =>
    {
        const { gate, sessions } = await Kit()
        const desktop = await sessions.IssueDesktop(new SignedInIdentity('acct-1', TenantSessionClaims.Of(F.TenantId, 'ada@acme.example')))
        assert.equal((await gate.Principal(Request(desktop.Token)))?.principalId, 'acct-1')
        assert.equal(gate.IsRealmBearer(Request(desktop.Token)), false)
        const console = await sessions.Store.Issue('acct-1', TenantSessionClaims.Of(F.TenantId, 'ada@acme.example'))
        assert.equal(await gate.Principal(Request(console.Token)), null)
    })

    it('without the console\'s realm a JWT-shaped bearer is no session and no realm bearer', async () =>
    {
        const { idp, sessions, directory } = await Kit()
        const gate = new DesktopAuthGate(sessions.Store, directory)
        const token = await Access(idp)
        assert.equal(await gate.Principal(Request(token)), null)
        assert.equal(gate.IsRealmBearer(Request(token)), false)
    })

    it('one verifier per realm address', async () =>
    {
        const idp = await FakeOidcIdp.Create(F.Issuer)
        let built = 0
        const realm = new DesktopRealm(F.Issuer, idp.DiscoveryUrl, new FakeOidcHttpClient(idp))
        const bearer = new RealmDesktopBearer({ Realm: async () => new DesktopRealm(realm.Issuer, realm.DiscoveryUrl, realm.Http) }, F.TenantId, r =>
        {
            built++
            return RealmDesktopBearer.VerifierOf(r)
        })
        const token = await Access(idp)
        assert.notEqual(await bearer.SessionOf(token), null)
        assert.notEqual(await bearer.SessionOf(token), null)
        assert.equal(built, 1)
        assert.equal(await bearer.SessionOf('not-a-jwt'), null)
        assert.equal(RealmDesktopBearer.IsJwt('a.b.c'), true)
        assert.equal(RealmDesktopBearer.IsJwt('opaque-session-token'), false)
    })
})
