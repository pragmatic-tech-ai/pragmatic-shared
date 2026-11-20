import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { OidcRelyingParty } from '../oidc-relying-party.js'
import { OidcLoginEndpoint } from '../oidc-login-endpoint.js'
import type { OidcLoginEndpointOptions } from '../oidc-login-endpoint.js'
import type { IOidcClientConfig, IOidcClientProvider } from '../oidc-client-config.js'

class OneClient implements IOidcClientProvider
{
    public RequiredClaims: readonly string[] | undefined

    public constructor(private readonly idp: FakeOidcIdp, private readonly http: FakeOidcHttpClient)
    {
    }

    public async ClientFor(_req: IncomingMessage): Promise<IOidcClientConfig>
    {
        return { Issuer: this.idp.Issuer, DiscoveryUrl: this.idp.DiscoveryUrl, ClientId: 'cabinet', RedirectUri: 'https://cabinet.example/auth/oidc/callback', ClientSecret: 's', Http: this.http, RequiredClaims: this.RequiredClaims }
    }
}

/** One host with an OidcLoginEndpoint: begin with a query, then complete the sign-in the login page answered. */
class Journey
{
    public readonly Fixture = new HostFixture()
    public readonly Http: FakeOidcHttpClient
    public readonly Clients: OneClient

    public constructor(public readonly Idp: FakeOidcIdp)
    {
        this.Http = new FakeOidcHttpClient(Idp)
        this.Clients = new OneClient(Idp, this.Http)
    }

    public async Start(options: OidcLoginEndpointOptions = {}): Promise<this>
    {
        new OidcLoginEndpoint(new OidcRelyingParty(new InMemoryOidcFlowStateStore()), this.Clients, this.Fixture.Gate, options).Register(this.Fixture.Routes)
        await this.Fixture.Start()
        return this
    }

    public async Authorize(query: string): Promise<URL>
    {
        const begin = await this.Fixture.Send('/auth/oidc/begin' + query)
        assert.equal(begin.Status, 302)
        return new URL(begin.Header('location') ?? '')
    }

    public async Land(query: string, claims: Record<string, unknown> = { email: 'ann@example.com' }): Promise<{ Status: number, Location: string | undefined }>
    {
        const authorize = await this.Authorize(query)
        this.Http.NextTokenResponse = this.Idp.TokenResponse(await this.Idp.MintIdToken({ sub: 'ann', aud: 'cabinet', nonce: authorize.searchParams.get('nonce'), ...claims }))
        const callback = await this.Fixture.Send('/auth/oidc/callback?code=c&state=' + encodeURIComponent(authorize.searchParams.get('state') ?? ''))
        return { Status: callback.Status, Location: callback.Header('location') }
    }

    public async Stop(): Promise<void>
    {
        await this.Fixture.Stop()
    }
}

describe('OidcLoginEndpoint begin options: sign-up, login hint, return path', () =>
{
    let journey: Journey

    beforeEach(async () =>
    {
        journey = new Journey(await FakeOidcIdp.Create())
    })

    afterEach(async () => await journey.Stop())

    it('prompt=create asks the issuer for sign-up when it advertises create; nothing else is forwarded as a prompt', async () =>
    {
        journey.Idp.PromptValues = ['login', 'create']
        await journey.Start()
        assert.equal((await journey.Authorize('?prompt=create')).searchParams.get('prompt'), 'create')
        assert.equal((await journey.Authorize('')).searchParams.has('prompt'), false)
        assert.equal((await journey.Authorize('?prompt=login')).searchParams.has('prompt'), false)
    })

    it('an issuer that does not advertise create gets a plain sign-in', async () =>
    {
        await journey.Start()
        assert.equal((await journey.Authorize('?prompt=create')).searchParams.has('prompt'), false)
    })

    it('login_hint is passed through; a malformed or oversized hint is dropped', async () =>
    {
        await journey.Start()
        assert.equal((await journey.Authorize('?login_hint=' + encodeURIComponent('ann@example.com'))).searchParams.get('login_hint'), 'ann@example.com')
        for (const bad of ['ann @example.com', 'ann\n@example.com', 'a'.repeat(255), ''])
        {
            assert.equal((await journey.Authorize('?login_hint=' + encodeURIComponent(bad))).searchParams.has('login_hint'), false, bad)
        }
    })

    it('an allow-listed return path rides the flow state and is where the callback lands', async () =>
    {
        await journey.Start({ ReturnPaths: ['/register'] })
        assert.deepEqual(await journey.Land('?return=' + encodeURIComponent('/register?plan=pro')), { Status: 302, Location: '/register?plan=pro' })
        assert.deepEqual(await journey.Land(''), { Status: 302, Location: '/' })
    })

    it('a return path that is not relative, same-origin and allow-listed lands on the default instead', async () =>
    {
        await journey.Start({ ReturnPaths: ['/register'], AfterSignInPath: '/home' })
        for (const bad of ['https://evil.example/register', '//evil.example/register', '/\\evil.example', '/register/../admin', '/registered', '/settings'])
        {
            assert.deepEqual(await journey.Land('?return=' + encodeURIComponent(bad)), { Status: 302, Location: '/home' }, bad)
        }
    })

    it('without ReturnPaths a return path is ignored', async () =>
    {
        await journey.Start()
        assert.deepEqual(await journey.Land('?return=' + encodeURIComponent('/register')), { Status: 302, Location: '/' })
    })

    it('the return path is never reflected in the authorize URL', async () =>
    {
        await journey.Start({ ReturnPaths: ['/register'] })
        assert.ok(!(await journey.Authorize('?return=' + encodeURIComponent('/register/secret-step'))).toString().includes('secret-step'))
    })

    it('with SignInFailedPath a failed callback answers 302 there (no cookie) instead of the 401', async () =>
    {
        await journey.Start({ SignInFailedPath: '/?sign_in=failed' })
        const failed = await journey.Fixture.Send('/auth/oidc/callback?code=c&state=unknown')
        assert.equal(failed.Status, 302)
        assert.equal(failed.Header('location'), '/?sign_in=failed')
        assert.equal(failed.Header('set-cookie'), undefined)
        assert.equal(failed.Header('cache-control'), 'no-store')
        assert.equal((await journey.Fixture.Send('/auth/oidc/callback?code=c')).Status, 400, 'a malformed callback stays 400')
    })

    it('SignInFailedPath must be a plain same-origin path', () =>
    {
        for (const bad of ['https://evil.example/', '//evil.example', 'failed'])
        {
            assert.throws(() => new OidcLoginEndpoint(new OidcRelyingParty(new InMemoryOidcFlowStateStore()), journey.Clients, journey.Fixture.Gate, { SignInFailedPath: bad }), /SignInFailedPath/, bad)
        }
    })

    it('the client config can require claims: a token without them is a generic 401', async () =>
    {
        journey.Clients.RequiredClaims = ['iat', 'email']
        await journey.Start()
        assert.equal((await journey.Land('', { email: 'ann@example.com' })).Status, 302)
        assert.equal((await journey.Land('', {})).Status, 401)
    })
})
