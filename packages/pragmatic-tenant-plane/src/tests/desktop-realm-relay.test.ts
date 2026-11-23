import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { AppHost, AppHostConfig, OidcRelyingParty, RouteAuth, RouteTable, SignedInIdentity, type IOidcClientConfig } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore, type IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import type { TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AuditRegistry, type AuditRecord } from '../audit-record.js'
import type { EnvironmentUrlsLease, IEnvironmentReach } from '../environment-endpoints.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { IEnvironmentService } from '../environment-service-contract.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { MemoryRecordMap } from '../record-map.js'
import { TenantAdminCapabilities } from '../tenant-api/tenant-admin-capabilities.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import type { TenantProfileDto } from '../tenant-api/tenant-profile-dto.js'
import { DesktopAuthGate } from '../tenant-auth/desktop-auth-gate.js'
import { DesktopEndpoint } from '../tenant-auth/desktop-endpoint.js'
import { DesktopRealms } from '../tenant-auth/desktop-realm-sign-in.js'
import { DesktopRelay, WsUpstreamDialer, type IRelayClock, type IRelayTimer } from '../tenant-auth/desktop-relay.js'
import { DesktopSignInFlows } from '../tenant-auth/desktop-sign-in-flows.js'
import { DesktopTargets } from '../tenant-auth/desktop-targets.js'
import { RealmDesktopBearer } from '../tenant-auth/realm-desktop-bearer.js'
import type { ITenantOidcClients, TenantOidcClientKind } from '../tenant-auth/tenant-oidc-clients.js'
import { TenantPrincipalSessions } from '../tenant-auth/tenant-principal-sessions.js'
import { TenantSessionClaims, TenantSessions } from '../tenant-auth/tenant-sessions.js'

/** A manual clock for the relay's heartbeat and deadline: Advance fires every timer that falls due, in order. */
class ManualRelayClock implements IRelayClock
{
    public now = Date.now()
    private readonly timers: { due: number; callback: () => void; cancelled: boolean }[] = []

    public Now(): number
    {
        return this.now
    }

    public Schedule(callback: () => void, delayMs: number): IRelayTimer
    {
        const timer = { due: this.now + delayMs, callback, cancelled: false }
        this.timers.push(timer)
        return { Cancel: () => { timer.cancelled = true } }
    }

    public Advance(ms: number): void
    {
        const target = this.now + ms
        for (;;)
        {
            const next = this.timers.filter(t => !t.cancelled && t.due <= target).sort((a, b) => a.due - b.due)[0]
            if (next === undefined)
            {
                break
            }
            next.cancelled = true
            this.now = Math.max(this.now, next.due)
            next.callback()
        }
        this.now = target
    }
}

/** An environment server that answers every request with an empty result. */
class EmptyUpstream
{
    private wss: WebSocketServer | undefined

    public async Start(): Promise<number>
    {
        const wss = new WebSocketServer({ port: 0, host: RealmRelayKit.Loopback })
        this.wss = wss
        await new Promise<void>(res => wss.once('listening', () => res()))
        wss.on('connection', ws => ws.on('message', data =>
        {
            const msg = JSON.parse(String(data)) as { id?: number }
            if (msg.id !== undefined)
            {
                ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: [] }))
            }
        }))
        return (wss.address() as AddressInfo).port
    }

    public async Stop(): Promise<void>
    {
        for (const ws of this.wss?.clients ?? [])
        {
            ws.terminate()
        }
        await new Promise<void>(res => this.wss?.close(() => res()) ?? res())
    }
}

/** The environments and their credential mints (a credential lives an hour, far past any token here); a mint can be held. */
class RealmRelayService
{
    public hold: Promise<void> | undefined
    public minting = false

    public constructor(private readonly clock: ManualRelayClock)
    {
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return [{ name: RealmRelayKit.Dev, type: EnvType.Development, template: Template.DevBlank, environmentId: RealmRelayKit.Dev, tenantId: RealmRelayKit.TenantId, createdAt: '2026-10-23T00:00:00.000Z', status: EnvStatus.Running }]
    }

    public async AdminIssueMakerToken(): Promise<TokenIssuedDto>
    {
        this.minting = true
        await this.hold
        return { tokenRef: 'ref-1', token: 'minted-maker', principalId: 'maker', scopes: [], expiresAt: new Date(this.clock.Now() + 60 * 60 * 1000).toISOString() }
    }

    public async AdminRevokeToken(): Promise<void>
    {
    }
}

class RealmRelayReach
{
    public constructor(private readonly port: number)
    {
    }

    public async UrlsFor(): Promise<EnvironmentUrlsLease>
    {
        return { httpUrl: 'http://127.0.0.1:' + String(this.port), wsUrl: 'ws://127.0.0.1:' + String(this.port), Release: () => undefined, Fail: () => undefined }
    }
}

class RealmRelayDirectory implements ITenantDirectory
{
    public createdAt = '2026-01-01T00:00:00.000Z'

    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === RealmRelayKit.TenantId ? { id, clientId: 'c1', displayName: 'Acme Corp', createdAt: this.createdAt, ownerPrincipalId: 'owner-1' } : undefined
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

/** The console's OIDC clients: the realm path never asks for one. */
class UnusedClients implements ITenantOidcClients
{
    private static readonly Unused = 'the realm path asks the console for no OIDC client'

    public async ClientFor(): Promise<IOidcClientConfig>
    {
        throw new Error(UnusedClients.Unused)
    }

    public async For(_kind: TenantOidcClientKind): Promise<IOidcClientConfig>
    {
        throw new Error(UnusedClients.Unused)
    }
}

/** The fake IdP's discovery and keys, which can be made unreachable. */
class SwitchableHttp implements IHttpClient
{
    public Down = false

    public constructor(private readonly inner: IHttpClient)
    {
    }

    public async GetJson(url: string): Promise<unknown>
    {
        if (this.Down)
        {
            throw new Error('unreachable')
        }
        return await this.inner.GetJson(url)
    }

    public async PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        return await this.inner.PostForm(url, fields)
    }
}

/**
 * The in-hive console's desktop surface and relay over one AppHost, composed as TenantPlaneComposer does for a console
 * tenant: the realm is a fake IdP (its discovery and keys through a fake HTTP client) found through the IdP connection.
 * Token lifetimes stay under the relay's 30 s heartbeat, so no ping falls inside a test's clock steps.
 */
class RealmRelayKit
{
    public static readonly TenantId = 'acme'
    public static readonly Dev = 'acme-dev'
    public static readonly Loopback = '127.0.0.1'
    public static readonly Browser = 'https://idp.acme.example'
    public static readonly Issuer = 'https://idp.acme.example/realms/acme'
    public static readonly Subject = 'acct-1'
    public static readonly Email = 'ada@acme.example'
    public static readonly TenantHost = 'acme.lvh.me'
    public static readonly TestTimeout = { timeout: 30_000 }

    public readonly clock = new ManualRelayClock()
    public readonly directory = new RealmRelayDirectory()
    public readonly sessions = new TenantSessions(TenantSessions.InMemory(), false)
    public readonly service = new RealmRelayService(this.clock)
    public principals!: TenantPrincipalSessions
    public idp!: FakeOidcIdp
    public http!: SwitchableHttp
    public relay: DesktopRelay | undefined
    private upstream = new EmptyUpstream()
    private host: AppHost | undefined
    private port = 0

    /** `coHosted`: the platform's co-hosted tenant plane (no console tenant: the lookup by host, the bearer by issuer). */
    public async Start(tokenAuthMethods: readonly string[] | null = ['client_secret_basic', 'none'], realmSignIn: boolean = true, coHosted: boolean = false): Promise<void>
    {
        const K = RealmRelayKit
        this.idp = await FakeOidcIdp.Create(K.Issuer)
        this.idp.TokenAuthMethods = tokenAuthMethods
        this.http = new SwitchableHttp(new FakeOidcHttpClient(this.idp))
        const conn: IdpConnection = { baseUrl: K.Browser, browserBaseUrl: K.Browser, ca: Buffer.alloc(0), adminToken: 'admin', adminTokenRef: 'ref', caDir: '' }
        const realms = new DesktopRealms({ ConnectForTenant: async () => conn }, this.directory, realmSignIn, { HttpFor: () => this.http })
        const consoleTenant = coHosted ? undefined : K.TenantId
        const bearer = new RealmDesktopBearer(realms, consoleTenant)
        const gate = new DesktopAuthGate(this.sessions.Store, this.directory, bearer)
        const service = this.service as unknown as IEnvironmentService
        const targets = new DesktopTargets(service)
        const upstreamPort = await this.upstream.Start()
        const audit = new AuditRegistry(new MemoryRecordMap<AuditRecord>())
        await audit.Load()
        const relay = new DesktopRelay(gate, targets, service, new RealmRelayReach(upstreamPort) as unknown as IEnvironmentReach, audit, new WsUpstreamDialer(), undefined, false, this.clock)
        this.relay = relay
        this.principals = new TenantPrincipalSessions(this.sessions.Store)
        this.principals.Attach(bearer)
        this.principals.Attach(relay)
        const endpoint = new DesktopEndpoint({ RelyingParty: new OidcRelyingParty(new InMemoryOidcFlowStateStore()), Clients: new UnusedClients() }, this.sessions, gate, new DesktopSignInFlows(), targets, this.directory,
            s => ({ principalId: s.principalId, roleLabel: TenantAdminCapabilities.For(s).roleLabel, appRoles: s.appRoles }) as unknown as TenantProfileDto, relay, consoleTenant, realms, coHosted ? { TenantFor: (host: string | undefined) => host?.startsWith(K.TenantHost) === true ? K.TenantId : undefined } : undefined)
        const routes = new RouteTable()
        endpoint.Register(routes)
        routes.AddSocket({ Pattern: DesktopRelay.Path, Auth: RouteAuth.Public, Admit: req => relay.Admit(req), Handler: (ws, ctx) => relay.Attach(ws, ctx.Request) })
        this.host = new AppHost(new AppHostConfig({ AllowedHosts: [K.TenantHost] }), { Routes: routes })
        await this.host.Listen(0, K.Loopback)
        this.port = this.host.Address().port
    }

    public async Stop(): Promise<void>
    {
        await this.upstream.Stop()
        await this.host?.Close()
        await this.relay?.Close()
    }

    /** A realm access token as the realm sign-in service issues one for plexus. */
    public Access(sid: string, claims: Record<string, unknown> = {}, expSecondsFromNow: number = 20, typ: string = 'at+jwt'): Promise<string>
    {
        const K = RealmRelayKit
        return this.idp.MintIdToken({ sub: K.Subject, aud: 'pragmatic-tenant-admin', azp: 'plexus', client_id: 'plexus', sid, email: K.Email, roles: [], app_roles: {}, ...claims }, { typ, expSecondsFromNow })
    }

    /** Moves the relay clock to `offsetMs` from the token's `exp` (the deadline the relay set from it). */
    public AdvanceToExp(token: string, offsetMs: number): void
    {
        const exp = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).exp as number
        this.clock.Advance(exp * 1000 + offsetMs - this.clock.now)
    }

    public Get(path: string, bearer?: string): Promise<{ status: number; body: Record<string, unknown> | undefined }>
    {
        return this.Send('GET', path, bearer)
    }

    public Send(method: string, path: string, bearer?: string, host?: string): Promise<{ status: number; body: Record<string, unknown> | undefined }>
    {
        const headers: Record<string, string> = bearer === undefined ? {} : { authorization: 'Bearer ' + bearer }
        if (host !== undefined)
        {
            headers.host = host + ':' + String(this.port)
        }
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: RealmRelayKit.Loopback, port: this.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown> })
                })
            })
            req.on('error', reject)
            req.end()
        })
    }

    /** Dials the relay; the refusal status, or 101 with the open socket. */
    public Dial(bearer: string): Promise<{ status: number; ws?: WebSocket }>
    {
        const ws = new WebSocket('ws://127.0.0.1:' + String(this.port) + DesktopRelay.Path + '?environment=' + RealmRelayKit.Dev + '&action=contribute', { headers: { Authorization: 'Bearer ' + bearer } })
        return new Promise(res =>
        {
            ws.once('unexpected-response', (_req, response) =>
            {
                res({ status: response.statusCode ?? 0 })
                ws.terminate()
            })
            ws.once('open', () => res({ status: 101, ws }))
            ws.once('error', () => res({ status: -1 }))
        })
    }

    public async Open(bearer: string): Promise<WebSocket>
    {
        const dialled = await this.Dial(bearer)
        assert.equal(dialled.status, 101)
        return dialled.ws as WebSocket
    }

    public static Closed(ws: WebSocket): Promise<number>
    {
        return new Promise(res => ws.once('close', code => res(code)))
    }

    public static async RoundTrip(ws: WebSocket, id: number): Promise<void>
    {
        const answer = new Promise<Record<string, unknown>>(res => ws.once('message', data => res(JSON.parse(String(data)) as Record<string, unknown>)))
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'graph/list', params: {} }))
        assert.deepEqual((await answer).result, [])
    }

    public static async Until(check: () => boolean): Promise<void>
    {
        for (let i = 0; i < 300 && !check(); i++)
        {
            await new Promise(res => setTimeout(res, 10))
        }
        assert.ok(check(), 'condition not reached')
    }
}

describe('the console names its realm sign-in and takes realm access tokens (E.s S4-S6)', () =>
{
    const K = RealmRelayKit
    let kit: RealmRelayKit

    beforeEach(() =>
    {
        kit = new RealmRelayKit()
    })

    afterEach(async () =>
    {
        await kit.Stop()
    })

    it('the lookup names issuer and plexus once the realm advertises none', K.TestTimeout, async () =>
    {
        await kit.Start()
        const lookup = await kit.Get('/desktop/console')
        assert.equal(lookup.status, 200)
        assert.deepEqual(lookup.body, { tenantId: K.TenantId, tenantName: 'Acme Corp', signIn: { issuer: K.Issuer, clientId: 'plexus' } })
    })

    it('no signIn while the realm does not advertise none', K.TestTimeout, async () =>
    {
        await kit.Start(['client_secret_basic'])
        assert.deepEqual((await kit.Get('/desktop/console')).body, { tenantId: K.TenantId, tenantName: 'Acme Corp' })
    })

    it('no signIn with the setting off; the realm\'s tokens stay bearers', K.TestTimeout, async () =>
    {
        await kit.Start(undefined, false)
        assert.deepEqual((await kit.Get('/desktop/console')).body, { tenantId: K.TenantId, tenantName: 'Acme Corp' })
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1'))).status, 200)
    })

    it('targets accept a realm access token and the session holds its roles', K.TestTimeout, async () =>
    {
        await kit.Start()
        const targets = await kit.Get('/desktop/targets', await kit.Access('fam-1'))
        assert.equal(targets.status, 200)
        assert.deepEqual(targets.body, { contribute: [{ name: K.Dev, status: EnvStatus.Running }], publish: [] })
        const member = await kit.Get('/desktop/profile', await kit.Access('fam-1', { app_roles: { 'pragmatic-tenant-admin': ['auditor'], ledger: ['viewer'] } }))
        assert.ok((member.body?.appRoles as string[]).includes('auditor'), 'this application\'s roles from the token')
        assert.ok(!(member.body?.appRoles as string[]).includes('viewer'), 'another application\'s roles are not this one\'s')
        const admin = await kit.Get('/desktop/profile', await kit.Access('fam-1', { roles: ['admin'] }))
        assert.equal(admin.body?.principalId, K.Subject)
        assert.equal(admin.body?.roleLabel, TenantAdminCapabilities.For({ id: '', tenantId: K.TenantId, principalId: K.Subject, expiresAt: '', roles: ['admin'] }).roleLabel)
    })

    it('an ID token as bearer is 401, and so is an access token for the client instead of the console', K.TestTimeout, async () =>
    {
        await kit.Start()
        const idToken = await kit.idp.MintIdToken({ sub: K.Subject, aud: 'plexus', azp: 'plexus', sid: 'fam-1', email: K.Email })
        assert.equal((await kit.Get('/desktop/targets', idToken)).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', { aud: 'plexus' }))).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', {}, 20, 'JWT'))).status, 401)
    })

    it('another realm\'s or another client\'s token is 401', K.TestTimeout, async () =>
    {
        await kit.Start()
        const otherRealm = await kit.idp.MintIdToken({ sub: K.Subject, aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt', issuer: 'https://idp.acme.example/realms/globex' })
        assert.equal((await kit.Get('/desktop/targets', otherRealm)).status, 401)
        const forger = await FakeOidcIdp.Create(K.Issuer)
        const forged = await forger.MintIdToken({ sub: K.Subject, aud: 'pragmatic-tenant-admin', azp: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt' })
        assert.equal((await kit.Get('/desktop/targets', forged)).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', { azp: 'ledger' }))).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', { sid: undefined }))).status, 401, 'no sid, no desktop sign-in to end')
    })

    it('an expired token is 401, also inside the verifier\'s skew', K.TestTimeout, async () =>
    {
        await kit.Start()
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', {}, -120))).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1', {}, -5))).status, 401)
        assert.equal((await kit.Dial(await kit.Access('fam-1', {}, -5))).status, 401, 'a relay never opens past exp (no 502)')
    })

    it('a token issued before the tenant was (re-)created is 401', K.TestTimeout, async () =>
    {
        await kit.Start()
        const token = await kit.Access('fam-1')
        kit.directory.createdAt = new Date(Date.now() + 60_000).toISOString()
        assert.equal((await kit.Get('/desktop/targets', token)).status, 401)
    })

    it('a realm that cannot be reached is 503 on the routes and the relay, never a sign-out', K.TestTimeout, async () =>
    {
        await kit.Start()
        kit.http.Down = true
        const token = await kit.Access('fam-1')
        assert.equal((await kit.Get('/desktop/targets', token)).status, 503)
        assert.equal((await kit.Send('POST', '/desktop/sign-out', token)).status, 503)
        assert.equal((await kit.Dial(token)).status, 503)
        kit.http.Down = false
        assert.equal((await kit.Get('/desktop/targets', token)).status, 200, 'a failed fetch is not cached')
    })

    it('the desktop session bearer still works', K.TestTimeout, async () =>
    {
        await kit.Start()
        const issued = await kit.sessions.IssueDesktop(new SignedInIdentity(K.Subject, TenantSessionClaims.Of(K.TenantId, K.Email)))
        assert.equal((await kit.Get('/desktop/targets', issued.Token)).status, 200)
        assert.equal((await kit.Send('POST', '/desktop/sign-out', issued.Token)).status, 204)
        assert.equal((await kit.Get('/desktop/targets', issued.Token)).status, 401, 'its sign-out ended it')
    })

    it('a relay closes 4001 at the token\'s exp when it is earlier than the credential\'s', K.TestTimeout, async () =>
    {
        await kit.Start()
        const token = await kit.Access('fam-1', {}, 20)
        const ws = await kit.Open(token)
        const closed = RealmRelayKit.Closed(ws)
        kit.AdvanceToExp(token, -1_000)
        await RealmRelayKit.RoundTrip(ws, 1)
        kit.AdvanceToExp(token, 1)
        assert.equal(await closed, 4001)
    })

    it('a re-opened relay with a renewed token lives to the new exp', K.TestTimeout, async () =>
    {
        await kit.Start()
        const firstToken = await kit.Access('fam-1', {}, 20)
        const renewedToken = await kit.Access('fam-1', {}, 26)
        const first = await kit.Open(firstToken)
        const firstClosed = RealmRelayKit.Closed(first)
        const renewed = await kit.Open(renewedToken)
        const renewedClosed = RealmRelayKit.Closed(renewed)
        kit.AdvanceToExp(firstToken, 1)
        assert.equal(await firstClosed, 4001)
        await RealmRelayKit.RoundTrip(renewed, 1)
        kit.AdvanceToExp(renewedToken, 1)
        assert.equal(await renewedClosed, 4001)
    })

    it('sign-out closes the relays of the same sid opened under earlier tokens and leaves another sid\'s relays open', K.TestTimeout, async () =>
    {
        await kit.Start()
        const earlier = await kit.Open(await kit.Access('fam-1'))
        const later = await kit.Open(await kit.Access('fam-1'))
        const otherDesktop = await kit.Open(await kit.Access('fam-2'))
        const earlierClosed = RealmRelayKit.Closed(earlier)
        const laterClosed = RealmRelayKit.Closed(later)
        assert.equal((await kit.Send('POST', '/desktop/sign-out', await kit.Access('fam-1'))).status, 204)
        assert.equal(await earlierClosed, 1000)
        assert.equal(await laterClosed, 1000)
        await RealmRelayKit.RoundTrip(otherDesktop, 1)
        assert.equal(otherDesktop.readyState, WebSocket.OPEN)
        assert.equal((await kit.Dial(await kit.Access('fam-1'))).status, 401, 'a signed-out sign-in opens no relay afterwards')
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1'))).status, 401)
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-2'))).status, 200)
        otherDesktop.close()
    })

    it('a relay still connecting when its sign-in signs out never opens', K.TestTimeout, async () =>
    {
        await kit.Start()
        let release: () => void = () => undefined
        kit.service.hold = new Promise<void>(res => { release = res })
        const dial = kit.Dial(await kit.Access('fam-1'))
        await RealmRelayKit.Until(() => kit.service.minting)
        assert.equal((await kit.Send('POST', '/desktop/sign-out', await kit.Access('fam-1'))).status, 204)
        release()
        assert.equal((await dial).status, 401)
    })

    it('sign-out with an expired token is 401 and the relays end at its exp', K.TestTimeout, async () =>
    {
        await kit.Start()
        const token = await kit.Access('fam-1', {}, 20)
        const ws = await kit.Open(token)
        const closed = RealmRelayKit.Closed(ws)
        assert.equal((await kit.Send('POST', '/desktop/sign-out', await kit.Access('fam-1', {}, -120))).status, 401)
        await RealmRelayKit.RoundTrip(ws, 1)
        kit.AdvanceToExp(token, 1)
        assert.equal(await closed, 4001)
    })

    it('an Owner reset closes the realm relays and refuses the tokens issued until then', K.TestTimeout, async () =>
    {
        await kit.Start()
        const token = await kit.Access('fam-1')
        const ws = await kit.Open(token)
        const closed = RealmRelayKit.Closed(ws)
        await kit.principals.RevokeAllFor(K.TenantId, K.Subject)
        assert.equal(await closed, 1008)
        assert.equal((await kit.Get('/desktop/targets', token)).status, 401)
    })

    it('the co-hosted plane names the request host realm and takes its tokens; without a tenant host no lookup', K.TestTimeout, async () =>
    {
        await kit.Start(undefined, true, true)
        assert.deepEqual((await kit.Send('GET', '/desktop/console', undefined, K.TenantHost)).body, { tenantId: K.TenantId, tenantName: 'Acme Corp', signIn: { issuer: K.Issuer, clientId: 'plexus' } })
        const loopback = await kit.Get('/desktop/console')
        assert.equal(loopback.status, 404)
        assert.deepEqual(loopback.body, { error: 'unknown-tenant' })
        assert.equal((await kit.Get('/desktop/targets', await kit.Access('fam-1'))).status, 200, 'the tenant is the realm the token names')
        const ws = await kit.Open(await kit.Access('fam-1'))
        ws.close()
    })

    it('a realm relay is refused without a valid token and still closes 4003 on retirement', K.TestTimeout, async () =>
    {
        await kit.Start()
        assert.equal((await kit.Dial(await kit.Access('fam-1', {}, -120))).status, 401)
        assert.equal((await kit.Dial(await kit.Access('fam-1', { aud: 'plexus' }))).status, 401)
        const ws = await kit.Open(await kit.Access('fam-1'))
        const closed = RealmRelayKit.Closed(ws)
        kit.relay!.Retire(DesktopRelay.ConsoleRetiredCloseCode)
        assert.equal(await closed, 4003)
    })
})
