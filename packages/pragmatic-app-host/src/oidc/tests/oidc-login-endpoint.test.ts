import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { OidcRelyingParty } from '../oidc-relying-party.js'
import { OidcLoginEndpoint } from '../oidc-login-endpoint.js'
import type { IOidcClientConfig, IOidcClientProvider } from '../oidc-client-config.js'
import { OidcLoginError } from '../oidc-login-error.js'
import { SessionClaims } from '../../session/session-claims.js'

/** The app-supplied provider: resolves the client from the request host (as the tenant console resolves its tenant). */
class HostClients implements IOidcClientProvider
{
    public readonly Hosts: string[] = []
    public Refuse = false

    public constructor(private readonly idp: FakeOidcIdp, private readonly http: FakeOidcHttpClient)
    {
    }

    public async ClientFor(req: IncomingMessage): Promise<IOidcClientConfig>
    {
        this.Hosts.push(String(req.headers.host))
        if (this.Refuse)
        {
            throw new OidcLoginError()
        }
        return { Issuer: this.idp.Issuer, DiscoveryUrl: this.idp.DiscoveryUrl, ClientId: 'console', RedirectUri: 'https://console.example/auth/oidc/callback', ClientSecret: 's', Http: this.http, FixedClaims: SessionClaims.From({ tenant: 'acme' }) }
    }
}

describe('OidcLoginEndpoint', () =>
{
    let fixture: HostFixture
    let idp: FakeOidcIdp
    let http: FakeOidcHttpClient
    let clients: HostClients

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        idp = await FakeOidcIdp.Create()
        http = new FakeOidcHttpClient(idp)
        clients = new HostClients(idp, http)
        new OidcLoginEndpoint(new OidcRelyingParty(new InMemoryOidcFlowStateStore()), clients, fixture.Gate).Register(fixture.Routes)
        await fixture.Start()
    })

    afterEach(async () => await fixture.Stop())

    it('begin redirects to the IdP for the client the provider resolved from the request, no-store', async () =>
    {
        const answer = await fixture.Send('/auth/oidc/begin')
        assert.equal(answer.Status, 302)
        assert.ok((answer.Header('location') ?? '').startsWith(idp.AuthorizationEndpoint + '?'))
        assert.equal(answer.Header('cache-control'), 'no-store')
        assert.deepEqual(clients.Hosts, ['localhost:' + fixture.Port])
    })

    it('the callback issues the session cookie and redirects to /; the session carries the token claims and the fixed claims', async () =>
    {
        const location = new URL((await fixture.Send('/auth/oidc/begin')).Header('location') ?? '')
        http.NextTokenResponse = idp.TokenResponse(await idp.MintIdToken({ sub: 'user-1', aud: 'console', nonce: location.searchParams.get('nonce'), email: 'u@x', roles: ['tenant.admin'] }))
        const callback = await fixture.Send('/auth/oidc/callback?code=the-code&state=' + encodeURIComponent(location.searchParams.get('state') ?? ''))
        assert.equal(callback.Status, 302)
        assert.equal(callback.Header('location'), '/')
        const cookie = (callback.Header('set-cookie') ?? '').split(';')[0] as string
        const session = await fixture.Send('/api/session', { Cookie: cookie })
        assert.deepEqual(session.Json(), { subject: 'user-1', claims: { email: ['u@x'], roles: ['tenant.admin'], tenant: ['acme'] } })
    })

    it('a callback without code or state is 400', async () =>
    {
        assert.equal((await fixture.Send('/auth/oidc/callback?code=x')).Status, 400)
        assert.equal((await fixture.Send('/auth/oidc/callback?state=x')).Status, 400)
    })

    it('a failed callback is a generic 401 with no cookie and neither the code nor a secret', async () =>
    {
        const answer = await fixture.Send('/auth/oidc/callback?code=secret-code&state=unknown')
        assert.equal(answer.Status, 401)
        assert.equal(answer.Header('set-cookie'), undefined)
        assert.ok(!answer.Body.includes('secret-code'))
    })

    it('a provider that refuses (no such tenant) is a 401 at begin', async () =>
    {
        clients.Refuse = true
        assert.equal((await fixture.Send('/auth/oidc/begin')).Status, 401)
    })

    it('registers the session and logout routes too', async () =>
    {
        assert.equal((await fixture.Send('/api/session')).Status, 401)
        assert.equal((await fixture.Send('/api/logout', { Method: 'POST' })).Status, 204)
    })
})
