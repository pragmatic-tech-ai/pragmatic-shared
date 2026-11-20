import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp, TlsTestRealm } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { SqlOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { OidcRelyingParty } from '../oidc-relying-party.js'
import { OidcLoginError } from '../oidc-login-error.js'
import type { IOidcClientConfig } from '../oidc-client-config.js'
import { SessionClaims } from '../../session/session-claims.js'

class RpFixture
{
    public static readonly ClientId = 'pragmatic-cabinet'
    public static readonly RedirectUri = 'https://cabinet.example/auth/oidc/callback'
    public static readonly Secret = 'client-secret-value'

    public static async Make(): Promise<{ Idp: FakeOidcIdp, Http: FakeOidcHttpClient, Client: IOidcClientConfig }>
    {
        const idp = await FakeOidcIdp.Create()
        const http = new FakeOidcHttpClient(idp)
        const client: IOidcClientConfig = { Issuer: idp.Issuer, DiscoveryUrl: idp.DiscoveryUrl, ClientId: RpFixture.ClientId, RedirectUri: RpFixture.RedirectUri, ClientSecret: RpFixture.Secret, Http: http }
        return { Idp: idp, Http: http, Client: client }
    }

    public static NonceOf(url: string): string
    {
        return new URL(url).searchParams.get('nonce') ?? ''
    }

    public static async Answer(idp: FakeOidcIdp, http: FakeOidcHttpClient, nonce: string, payload: Record<string, unknown> = {}): Promise<void>
    {
        http.NextTokenResponse = idp.TokenResponse(await idp.MintIdToken({ sub: 'user-1', aud: RpFixture.ClientId, nonce, email: 'u@x', roles: ['tenant.admin', 'app.reader'], ...payload }))
    }
}

test('Begin returns an authorize URL carrying the client, the callback, state, nonce and an S256 PKCE challenge', async () =>
{
    const { Idp: idp, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    const begun = await rp.Begin(client)
    const url = new URL(begun.Url)
    assert.equal(url.origin + url.pathname, idp.AuthorizationEndpoint)
    assert.equal(url.searchParams.get('client_id'), RpFixture.ClientId)
    assert.equal(url.searchParams.get('redirect_uri'), RpFixture.RedirectUri)
    assert.equal(url.searchParams.get('state'), begun.State)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok((url.searchParams.get('scope') ?? '').split(' ').includes('openid'))
})

test('Complete exchanges the code and maps the id token to the subject, its mapped claims, its roles and the fixed claims', async () =>
{
    const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    const begun = await rp.Begin({ ...client, FixedClaims: SessionClaims.From({ tenant: 'acme' }) })
    await RpFixture.Answer(idp, http, RpFixture.NonceOf(begun.Url))
    const identity = await rp.Complete({ ...client, FixedClaims: SessionClaims.From({ tenant: 'acme' }) }, 'the-code', begun.State)
    assert.equal(identity.Subject, 'user-1')
    assert.deepEqual(identity.Claims.ToJson(), { email: ['u@x'], roles: ['app.reader', 'tenant.admin'], tenant: ['acme'] })
    const posted = http.PostedFields[0]
    assert.equal(posted?.get('code'), 'the-code')
    assert.equal(posted?.get('client_secret'), RpFixture.Secret)
    assert.equal(posted?.get('redirect_uri'), RpFixture.RedirectUri)
})

test('a public client (no secret) posts no client_secret; the roles and claim mappings are configurable', async () =>
{
    const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { SessionRoleClaim: 'app_roles' })
    const publicClient: IOidcClientConfig = { ...client, ClientSecret: undefined, RolesClaim: 'groups', ClaimsMapping: new Map([['name', 'preferred_username']]) }
    const begun = await rp.Begin(publicClient)
    await RpFixture.Answer(idp, http, RpFixture.NonceOf(begun.Url), { groups: ['g1'], preferred_username: 'uu' })
    const identity = await rp.Complete(publicClient, 'c', begun.State)
    assert.equal(http.PostedFields[0]?.has('client_secret'), false)
    assert.deepEqual(identity.Claims.Values('app_roles'), ['g1'])
    assert.equal(identity.Claims.First('name'), 'uu')
})

test('the realm role claims: tenant roles into roles, the application roles into app_roles, other applications dropped', async () =>
{
    const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    const ledger: IOidcClientConfig = { ...client, Application: 'ledger' }
    const begun = await rp.Begin(ledger)
    await RpFixture.Answer(idp, http, RpFixture.NonceOf(begun.Url), { roles: ['admin', 'Not A Role'], app_roles: { ledger: ['sales', 'finance'], crm: ['viewer'] } })
    const identity = await rp.Complete(ledger, 'c', begun.State)
    assert.deepEqual(identity.Claims.Values('roles'), ['admin'])
    assert.deepEqual(identity.Claims.Values('app_roles'), ['finance', 'sales'])
})

test('a client without an application keeps no application roles; a token without role claims gives empty roles', async () =>
{
    const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    const begun = await rp.Begin(client)
    await RpFixture.Answer(idp, http, RpFixture.NonceOf(begun.Url), { roles: ['admin'], app_roles: { ledger: ['sales'] } })
    const identity = await rp.Complete(client, 'c', begun.State)
    assert.deepEqual(identity.Claims.Values('roles'), ['admin'])
    assert.equal(identity.Claims.Names().includes('app_roles'), false)
    const ledger: IOidcClientConfig = { ...client, Application: 'ledger' }
    const second = await rp.Begin(ledger)
    await RpFixture.Answer(idp, http, RpFixture.NonceOf(second.Url), { roles: undefined })
    const bare = await rp.Complete(ledger, 'c', second.State)
    assert.deepEqual(bare.Claims.Values('roles'), [])
    assert.deepEqual(bare.Claims.Values('app_roles'), [])
})

test('a wrong nonce, a replayed state, a failed token call or an unknown state is a generic OidcLoginError that leaks nothing', async () =>
{
    const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    const wrongNonce = await rp.Begin(client)
    await RpFixture.Answer(idp, http, 'not-the-nonce')
    await assert.rejects(rp.Complete(client, 'secret-code-1', wrongNonce.State), (err: Error) => err instanceof OidcLoginError && !err.message.includes('secret-code-1') && !err.message.includes(RpFixture.Secret))
    await assert.rejects(rp.Complete(client, 'secret-code-1', wrongNonce.State), OidcLoginError)
    const failing = await rp.Begin(client)
    http.FailTokenEndpoint = true
    await assert.rejects(rp.Complete(client, 'c', failing.State), OidcLoginError)
    await assert.rejects(rp.Complete(client, 'c', 'never-issued'), OidcLoginError)
})

test('a discovery failure at Begin is an OidcLoginError', async () =>
{
    const { Client: client } = await RpFixture.Make()
    const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
    await assert.rejects(rp.Begin({ ...client, DiscoveryUrl: 'https://unknown.example/.well-known/openid-configuration' }), OidcLoginError)
})

SqlTestSessions.Describe('OidcRelyingParty over SqlOidcFlowStateStore', (makeSession, backend) =>
{
    test(`${backend}: a sign-in begun on one replica completes on another`, async () =>
    {
        const { Idp: idp, Http: http, Client: client } = await RpFixture.Make()
        const session = await makeSession()
        const begun = await new OidcRelyingParty(await SqlOidcFlowStateStore.Open(session)).Begin(client)
        await RpFixture.Answer(idp, http, RpFixture.NonceOf(begun.Url))
        const identity = await new OidcRelyingParty(await SqlOidcFlowStateStore.Open(session)).Complete(client, 'c', begun.State)
        assert.equal(identity.Subject, 'user-1')
    })
})

test('a realm on a private CA: the CA bundle file (per client, or the relying party default) is trusted for discovery', async () =>
{
    let idp!: FakeOidcIdp
    const realm = await TlsTestRealm.Start(new Map([['/.well-known/openid-configuration', () => idp.DiscoveryDocument()]]))
    try
    {
        idp = await FakeOidcIdp.Create(realm.Origin)
        const client: IOidcClientConfig = { Issuer: idp.Issuer, DiscoveryUrl: idp.DiscoveryUrl, ClientId: RpFixture.ClientId, RedirectUri: RpFixture.RedirectUri }
        const begun = await new OidcRelyingParty(new InMemoryOidcFlowStateStore()).Begin({ ...client, CaBundleFile: TlsTestRealm.CaFile })
        assert.equal(new URL(begun.Url).origin + new URL(begun.Url).pathname, idp.AuthorizationEndpoint)
        assert.ok(await new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { CaBundleFile: TlsTestRealm.CaFile }).Begin(client))
        await assert.rejects(new OidcRelyingParty(new InMemoryOidcFlowStateStore()).Begin(client), OidcLoginError)
        await assert.rejects(new OidcRelyingParty(new InMemoryOidcFlowStateStore()).Begin({ ...client, CaBundleFile: TlsTestRealm.CaFile + '.missing' }), OidcLoginError)
    }
    finally
    {
        await realm.Stop()
    }
})
