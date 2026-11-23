import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { AppHost, AppHostConfig, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcIdp, MapSecretStore, TlsTestRealm, type TlsTestRealmRoute } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import type { IEnvironmentService } from '../environment-service-contract.js'
import type { IdpConnection } from '../idp-workload-driver.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { MemoryRecordMap } from '../record-map.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { TenantAdminClientRegistry } from '../tenant-auth/tenant-admin-client-record.js'
import { TenantHostResolver } from '../tenant-auth/tenant-host-resolver.js'
import { TenantSessions } from '../tenant-auth/tenant-sessions.js'
import { TenantPlaneComposer } from '../tenant-plane-composer.js'

class ComposerDirectory implements ITenantDirectory
{
    public GetTenant(id: string): TenantRecord | undefined
    {
        return id === ComposerKit.TenantId ? { id, clientId: 'c1', displayName: 'Acme Corp', createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: 'owner-1' } : undefined
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

/** A realm on a private CA (TlsTestRealm) whose keys a FakeOidcIdp signs with, reached through the IdP connection. */
class ComposerRealm
{
    public Idp!: FakeOidcIdp
    public Server!: TlsTestRealm
    public Issuer = ''

    public async Start(): Promise<void>
    {
        const routes = new Map<string, TlsTestRealmRoute>()
        this.Server = await TlsTestRealm.Start(routes)
        this.Issuer = this.Server.Origin + '/realms/' + ComposerKit.TenantId
        this.Idp = await FakeOidcIdp.Create(this.Issuer)
        routes.set('/realms/' + ComposerKit.TenantId + '/.well-known/openid-configuration', () => ({ issuer: this.Issuer, jwks_uri: this.Server.Origin + '/jwks', token_endpoint_auth_methods_supported: ['none'] }))
        routes.set('/jwks', () => this.Idp.Jwks())
    }

    public Connection(): IdpConnection
    {
        return { baseUrl: this.Server.Origin, browserBaseUrl: this.Server.Origin, ca: Buffer.from(TlsTestRealm.CaPem), adminToken: 'admin', adminTokenRef: 'ref', caDir: '' }
    }

    public Access(): Promise<string>
    {
        return this.Idp.MintIdToken({ sub: 'acct-1', aud: 'pragmatic-tenant-admin', azp: 'plexus', client_id: 'plexus', sid: 'fam-1' }, { typ: 'at+jwt' })
    }
}

/** One plane BuildTenantPlane composed, its desktop surface on an AppHost of its own. */
class ComposerKit
{
    public static readonly TenantId = 'acme'
    public static readonly TenantHost = 'acme.lvh.me'
    private host: AppHost | undefined
    private port = 0

    public async Start(realm: ComposerRealm, consoleTenant: string | undefined, setting: boolean | undefined): Promise<void>
    {
        const stub = {} as never
        const directory = new ComposerDirectory()
        const service = { ListReconciled: async () => [], OnChanged: () => () => undefined } as unknown as IEnvironmentService
        const resolver = new TenantHostResolver('lvh.me', 'https', directory)
        const plane = TenantPlaneComposer.BuildTenantPlane({
            Idp: { ConnectForTenant: async () => realm.Connection(), EnsureForTenant: async () => realm.Connection(), TeardownForTenant: async () => undefined },
            Directory: directory, Service: service, Rollout: stub, Orchestrators: stub, Placement: stub,
            Sessions: new TenantSessions(TenantSessions.InMemory(), false), Resolver: resolver,
            FlowStates: new InMemoryOidcFlowStateStore(), ClientSecrets: { Store: new MapSecretStore(), Registry: new TenantAdminClientRegistry(new MemoryRecordMap()), TtlMs: 1 },
            Desktop: true, ConsoleTenantId: consoleTenant, DesktopRealmSignIn: setting,
        })
        const routes = new RouteTable()
        plane.desktop!.Register(routes)
        this.host = new AppHost(new AppHostConfig({ AllowedHosts: [ComposerKit.TenantHost] }), { Routes: routes })
        await this.host.Listen(0, '127.0.0.1')
        this.port = this.host.Address().port
    }

    public async Stop(): Promise<void>
    {
        await this.host?.Close()
    }

    public Send(path: string, bearer?: string): Promise<{ status: number; body: Record<string, unknown> | undefined }>
    {
        const headers: Record<string, string> = { host: ComposerKit.TenantHost + ':' + String(this.port) }
        if (bearer !== undefined)
        {
            headers.authorization = 'Bearer ' + bearer
        }
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port: this.port, path, headers }, res =>
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
}

describe('TenantPlaneComposer wires the desktop realm sign-in by console and setting', () =>
{
    const realm = new ComposerRealm()

    before(async () =>
    {
        await realm.Start()
    })

    after(async () =>
    {
        await realm.Server.Stop()
    })

    for (const setting of [undefined, false])
    {
        it(`the co-hosted plane with the setting ${String(setting)}: no lookup route, realm tokens are no bearers`, async () =>
        {
            const kit = new ComposerKit()
            await kit.Start(realm, undefined, setting)
            try
            {
                assert.equal((await kit.Send('/desktop/console')).status, 404)
                assert.equal((await kit.Send('/desktop/targets', await realm.Access())).status, 401)
            }
            finally
            {
                await kit.Stop()
            }
        })
    }

    it('the co-hosted plane with the setting on: the lookup by host names the realm, its tokens are bearers', async () =>
    {
        const kit = new ComposerKit()
        await kit.Start(realm, undefined, true)
        try
        {
            assert.deepEqual((await kit.Send('/desktop/console')).body, { tenantId: ComposerKit.TenantId, tenantName: 'Acme Corp', signIn: { issuer: realm.Issuer, clientId: 'plexus' } })
            assert.equal((await kit.Send('/desktop/targets', await realm.Access())).status, 200)
        }
        finally
        {
            await kit.Stop()
        }
    })

    it('the in-hive console with the setting off names nothing but takes its realm tokens; on by default', async () =>
    {
        const off = new ComposerKit()
        await off.Start(realm, ComposerKit.TenantId, false)
        try
        {
            assert.deepEqual((await off.Send('/desktop/console')).body, { tenantId: ComposerKit.TenantId, tenantName: 'Acme Corp' })
            assert.equal((await off.Send('/desktop/targets', await realm.Access())).status, 200)
        }
        finally
        {
            await off.Stop()
        }
        const unset = new ComposerKit()
        await unset.Start(realm, ComposerKit.TenantId, undefined)
        try
        {
            assert.deepEqual((await unset.Send('/desktop/console')).body, { tenantId: ComposerKit.TenantId, tenantName: 'Acme Corp', signIn: { issuer: realm.Issuer, clientId: 'plexus' } })
        }
        finally
        {
            await unset.Stop()
        }
    })
})
