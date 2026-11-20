import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { OidcRelyingParty } from '../oidc-relying-party.js'
import { OidcLoginEndpoint } from '../oidc-login-endpoint.js'
import type { IOidcClientConfig, IOidcClientProvider } from '../oidc-client-config.js'
import { SessionTokenRetention } from '../tokens/session-token-retention.js'
import { SessionTokenVault } from '../tokens/session-token-vault.js'
import { InMemorySessionTokenRepository } from '../tokens/session-token-repository.js'
import { SessionGate } from '../../session/session-gate.js'
import { HttpMethod } from '../../http/http-method.js'
import { RouteAuth } from '../../routing/route.js'

class Clients implements IOidcClientProvider
{
    public constructor(private readonly idp: FakeOidcIdp, private readonly http: FakeOidcHttpClient)
    {
    }

    public async ClientFor(): Promise<IOidcClientConfig>
    {
        return { Issuer: this.idp.Issuer, DiscoveryUrl: this.idp.DiscoveryUrl, ClientId: 'cabinet', RedirectUri: 'https://cabinet.example/auth/oidc/callback', ClientSecret: 's', Http: this.http }
    }
}

class Clock
{
    public OffsetMs = 0
    public readonly Now = (): Date => new Date(Date.now() + this.OffsetMs)
}

/** A host whose sessions retain the upstream tokens, with a route that hands them to its handler. */
class RetentionFixture
{
    public readonly Host = new HostFixture()
    public readonly Clock = new Clock()
    public readonly Repository = new InMemorySessionTokenRepository()
    public Idp!: FakeOidcIdp
    public Http!: FakeOidcHttpClient
    public Retention!: SessionTokenRetention
    public Gate!: SessionGate

    public async Start(retain: boolean): Promise<this>
    {
        this.Idp = await FakeOidcIdp.Create()
        this.Http = new FakeOidcHttpClient(this.Idp)
        const clients = new Clients(this.Idp, this.Http)
        const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
        this.Retention = new SessionTokenRetention({ Vault: new SessionTokenVault(randomBytes(32)), Repository: this.Repository, RelyingParty: rp, Clients: clients, Now: this.Clock.Now })
        this.Gate = retain ? new SessionGate(this.Host.Sessions, this.Host.Cookie, this.Retention) : this.Host.Gate
        new OidcLoginEndpoint(rp, clients, this.Gate).Register(this.Host.Routes)
        this.Host.Routes.Add({ Method: HttpMethod.Get, Pattern: '/api/downstream', Auth: RouteAuth.Session, Handler: async ctx =>
        {
            const tokens = await this.Gate.UpstreamTokens(ctx.Request)
            ctx.WriteJson(200, { id: tokens?.IdToken ?? null, access: tokens?.AccessToken ?? null })
        } })
        await this.Host.Start({}, { Sessions: this.Gate })
        return this
    }

    /** Signs in through the callback with the token response `answer` builds from the flow's nonce; the session cookie. */
    public async SignIn(answer: (nonce: string) => Promise<object>): Promise<{ Cookie: string, SetCookie: string }>
    {
        const location = new URL((await this.Host.Send('/auth/oidc/begin')).Header('location') ?? '')
        this.Http.NextTokenResponse = await answer(location.searchParams.get('nonce') ?? '')
        const callback = await this.Host.Send('/auth/oidc/callback?code=c&state=' + encodeURIComponent(location.searchParams.get('state') ?? ''))
        assert.equal(callback.Status, 302)
        const setCookie = callback.Header('set-cookie') ?? ''
        return { Cookie: setCookie.split(';')[0] as string, SetCookie: setCookie }
    }

    public IdToken(nonce: string | undefined, sub: string = 'u1', expSecondsFromNow: number = 300): Promise<string>
    {
        return this.Idp.MintIdToken({ sub, aud: 'cabinet', nonce, email: 'u@x' }, { expSecondsFromNow })
    }

    public MaxAge(setCookie: string): number
    {
        return Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
    }
}

describe('OIDC sign-in with upstream token retention', () =>
{
    let f: RetentionFixture

    afterEach(async () => await f.Host.Stop())

    describe('opted in', () =>
    {
        beforeEach(async () =>
        {
            f = await new RetentionFixture().Start(true)
        })

        it('route handlers get the ID and access tokens through the session gate; the browser never sees them', async () =>
        {
            let idToken = ''
            const signIn = await f.SignIn(async nonce =>
            {
                idToken = await f.IdToken(nonce)
                return { id_token: idToken, access_token: 'at-1' }
            })
            assert.deepEqual((await f.Host.Send('/api/downstream', { Cookie: signIn.Cookie })).Json(), { id: idToken, access: 'at-1' })
            const probe = await f.Host.Send('/api/session', { Cookie: signIn.Cookie })
            assert.ok(!probe.Body.includes(idToken) && !probe.Body.includes('at-1'))
        })

        it('without a refresh token the session ends with the ID token (less the 30 s margin)', async () =>
        {
            const signIn = await f.SignIn(async nonce => ({ id_token: await f.IdToken(nonce, 'u1', 300) }))
            const maxAge = f.MaxAge(signIn.SetCookie)
            assert.ok(maxAge > 260 && maxAge <= 270, String(maxAge))
            f.Clock.OffsetMs = 280_000
            assert.equal((await f.Host.Send('/api/downstream', { Cookie: signIn.Cookie })).Json().id, null)
        })

        it('an ID token already inside the margin refuses the sign-in', async () =>
        {
            const location = new URL((await f.Host.Send('/auth/oidc/begin')).Header('location') ?? '')
            f.Http.NextTokenResponse = { id_token: await f.IdToken(location.searchParams.get('nonce') ?? '', 'u1', 20) }
            const callback = await f.Host.Send('/auth/oidc/callback?code=c&state=' + encodeURIComponent(location.searchParams.get('state') ?? ''))
            assert.equal(callback.Status, 401)
            assert.equal(callback.Header('set-cookie'), undefined)
        })

        it('with a refresh token the session keeps its policy and the tokens are refreshed on expiry', async () =>
        {
            const signIn = await f.SignIn(async nonce => ({ id_token: await f.IdToken(nonce, 'u1', 300), access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 }))
            assert.ok(f.MaxAge(signIn.SetCookie) > 3500)
            const refreshed = await f.IdToken(undefined, 'u1', 600)
            f.Http.NextTokenResponse = { id_token: refreshed, access_token: 'at-2', expires_in: 300 }
            f.Clock.OffsetMs = 45_000
            assert.deepEqual((await f.Host.Send('/api/downstream', { Cookie: signIn.Cookie })).Json(), { id: refreshed, access: 'at-2' })
            const posted = f.Http.PostedFields.at(-1) as ReadonlyMap<string, string>
            assert.equal(posted.get('grant_type'), 'refresh_token')
            assert.equal(posted.get('refresh_token'), 'rt-1')
        })

        it('a refresh the issuer refuses gives no tokens', async () =>
        {
            const signIn = await f.SignIn(async nonce => ({ id_token: await f.IdToken(nonce), access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 }))
            f.Http.FailTokenEndpoint = true
            f.Clock.OffsetMs = 45_000
            assert.equal((await f.Host.Send('/api/downstream', { Cookie: signIn.Cookie })).Json().id, null)
        })

        it('logout forgets the tokens', async () =>
        {
            const signIn = await f.SignIn(async nonce => ({ id_token: await f.IdToken(nonce) }))
            assert.equal(await f.Repository.DeleteExpired(new Date(0)), 0)
            assert.equal((await f.Host.Send('/api/logout', { Method: 'POST', Cookie: signIn.Cookie })).Status, 204)
            assert.equal(await f.Repository.DeleteExpired(new Date(8_000_000_000_000)), 0)
        })
    })

    it('not opted in: nothing is kept and handlers get no tokens', async () =>
    {
        f = await new RetentionFixture().Start(false)
        const signIn = await f.SignIn(async nonce => ({ id_token: await f.IdToken(nonce), access_token: 'at-1' }))
        assert.deepEqual((await f.Host.Send('/api/downstream', { Cookie: signIn.Cookie })).Json(), { id: null, access: null })
        assert.equal(await f.Repository.DeleteExpired(new Date(8_000_000_000_000)), 0)
    })
})
