import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { InMemoryOidcFlowStateStore, type IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { HostFixture } from '../../tests/support/host-fixture.js'
import type { TestResponse } from '../../tests/support/test-http.js'
import { OidcRelyingParty } from '../oidc-relying-party.js'
import { OidcLoginEndpoint, type OidcLoginEndpointOptions } from '../oidc-login-endpoint.js'
import { OidcSignOut } from '../oidc-sign-out.js'
import type { IOidcClientConfig, IOidcClientProvider } from '../oidc-client-config.js'
import { SessionTokenRetention } from '../tokens/session-token-retention.js'
import { SessionTokenVault } from '../tokens/session-token-vault.js'
import { InMemorySessionTokenRepository } from '../tokens/session-token-repository.js'
import type { ISessionTokenRepository, SealedSessionTokens } from '../tokens/session-token-repository.js'
import { SessionGate } from '../../session/session-gate.js'
import { SessionEndpoint } from '../../endpoints/session-endpoint.js'

/** The IdP's HTTP side, counting discovery reads and failing them on demand. */
class DiscoveryProbe implements IHttpClient
{
    public DiscoveryFetches = 0
    public FailDiscovery = false

    public constructor(private readonly idp: FakeOidcIdp, public readonly Inner: FakeOidcHttpClient)
    {
    }

    public async GetJson(url: string, bearer?: string): Promise<unknown>
    {
        if (url === this.idp.DiscoveryUrl)
        {
            this.DiscoveryFetches++
            if (this.FailDiscovery)
            {
                throw new Error('discovery unreachable')
            }
        }
        return await this.Inner.GetJson(url, bearer)
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        return this.Inner.PostForm(url, fields)
    }
}

class Clients implements IOidcClientProvider
{
    public Refuse = false

    public constructor(private readonly idp: FakeOidcIdp, private readonly http: IHttpClient)
    {
    }

    public async ClientFor(): Promise<IOidcClientConfig>
    {
        if (this.Refuse)
        {
            throw new Error('no such realm')
        }
        return { Issuer: this.idp.Issuer, DiscoveryUrl: this.idp.DiscoveryUrl, ClientId: 'console', RedirectUri: 'https://console.example/auth/oidc/callback', ClientSecret: 's', Http: this.http }
    }
}

/** The retained-token rows, failing reads or deletes on demand. */
class FlakyTokenRepository implements ISessionTokenRepository
{
    public FailFind = false
    public FailDelete = false
    public readonly Inner = new InMemorySessionTokenRepository()

    public Put(row: SealedSessionTokens): Promise<void>
    {
        return this.Inner.Put(row)
    }

    public async Find(sessionId: string): Promise<SealedSessionTokens | undefined>
    {
        if (this.FailFind)
        {
            throw new Error('token store unreachable')
        }
        return await this.Inner.Find(sessionId)
    }

    public async Delete(sessionId: string): Promise<void>
    {
        if (this.FailDelete)
        {
            throw new Error('token store unreachable')
        }
        await this.Inner.Delete(sessionId)
    }

    public DeleteExpired(now: Date): Promise<number>
    {
        return this.Inner.DeleteExpired(now)
    }
}

class Clock
{
    public OffsetMs = 0
    public readonly Now = (): Date => new Date(Date.now() + this.OffsetMs)
}

/** A host signing in by OIDC whose logout signs out at the IdP too. */
class SignOutFixture
{
    public static readonly SignedOutPage = 'https://console.example/signed-out'

    public readonly Host = new HostFixture()
    public readonly Clock = new Clock()
    public readonly Repository = new FlakyTokenRepository()
    public readonly Logged: string[] = []
    public Idp!: FakeOidcIdp
    public Http!: DiscoveryProbe
    public Clients!: Clients

    public async Start(options: { Retain?: boolean, EndSession?: string | null, Endpoint?: OidcLoginEndpointOptions } = {}): Promise<this>
    {
        this.Idp = await FakeOidcIdp.Create()
        this.Idp.EndSessionEndpoint = options.EndSession === undefined ? this.Idp.Issuer + '/logout' : options.EndSession
        this.Http = new DiscoveryProbe(this.Idp, new FakeOidcHttpClient(this.Idp))
        this.Clients = new Clients(this.Idp, this.Http)
        const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { Now: this.Clock.Now })
        const retention = new SessionTokenRetention({ Vault: new SessionTokenVault(randomBytes(32)), Repository: this.Repository, RelyingParty: rp, Clients: this.Clients, Now: this.Clock.Now })
        const gate = options.Retain === false ? this.Host.Gate : new SessionGate(this.Host.Sessions, this.Host.Cookie, retention)
        const endpoint: OidcLoginEndpointOptions = {
            PostLogoutRedirectUri: SignOutFixture.SignedOutPage,
            SignOut: { Now: this.Clock.Now, Log: (message, err) => { this.Logged.push(message + (err === undefined ? '' : ' ' + String(err))) } },
            ...options.Endpoint,
        }
        new OidcLoginEndpoint(rp, this.Clients, gate, endpoint).Register(this.Host.Routes)
        await this.Host.Start({}, { Sessions: gate })
        return this
    }

    /** Signs in through the callback; the session cookie and the ID token the IdP issued. */
    public async SignIn(answer?: (idToken: string) => object): Promise<{ Cookie: string, IdToken: string }>
    {
        const location = new URL((await this.Host.Send('/auth/oidc/begin')).Header('location') ?? '')
        const idToken = await this.Idp.MintIdToken({ sub: 'u1', aud: 'console', nonce: location.searchParams.get('nonce'), email: 'u@x' })
        this.Http.Inner.NextTokenResponse = answer === undefined ? this.Idp.TokenResponse(idToken) : answer(idToken)
        const callback = await this.Host.Send('/auth/oidc/callback?code=c&state=' + encodeURIComponent(location.searchParams.get('state') ?? ''))
        assert.equal(callback.Status, 302)
        return { Cookie: (callback.Header('set-cookie') ?? '').split(';')[0] as string, IdToken: idToken }
    }

    public Logout(cookie?: string): Promise<TestResponse>
    {
        return this.Host.Send('/api/logout', { Method: 'POST', Cookie: cookie })
    }

    public static Redirect(answer: TestResponse): string
    {
        return String(answer.Json()[SessionEndpoint.RedirectField])
    }
}

describe('OIDC logout signs out at the IdP too (RP-Initiated Logout)', () =>
{
    let f: SignOutFixture

    afterEach(async () => await f.Host.Stop())

    it('ends the session and its retained tokens, then sends the browser to the end-session endpoint with the ID token hint', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        const out = await f.Logout(signIn.Cookie)
        assert.equal(out.Status, 200)
        assert.equal(out.Header('cache-control'), 'no-store')
        assert.match(out.Header('set-cookie') ?? '', /^app_session=;.*Max-Age=0/)
        const redirect = new URL(SignOutFixture.Redirect(out))
        assert.equal(redirect.origin + redirect.pathname, f.Idp.Issuer + '/logout')
        assert.equal(redirect.searchParams.get('id_token_hint'), signIn.IdToken)
        assert.equal(redirect.searchParams.get('client_id'), 'console')
        assert.equal(redirect.searchParams.get('post_logout_redirect_uri'), SignOutFixture.SignedOutPage)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 401)
        assert.equal(await f.Repository.DeleteExpired(new Date(8_000_000_000_000)), 0)
        const bearer = signIn.Cookie.split('=')[1] as string
        assert.ok(f.Logged.every(line => !line.includes(signIn.IdToken) && !line.includes(bearer)))
    })

    it('keeps an end-session endpoint that already carries a query', async () =>
    {
        f = await new SignOutFixture().Start({ EndSession: 'https://idp.test/tenant/logout?realm=acme' })
        const redirect = new URL(SignOutFixture.Redirect(await f.Logout()))
        assert.equal(redirect.searchParams.get('realm'), 'acme')
        assert.equal(redirect.searchParams.get('client_id'), 'console')
    })

    it('without a session (or a stale cookie) still sends the browser to the IdP, without a hint', async () =>
    {
        f = await new SignOutFixture().Start()
        const fresh = new URL(SignOutFixture.Redirect(await f.Logout()))
        assert.equal(fresh.searchParams.get('id_token_hint'), null)
        assert.equal(fresh.searchParams.get('client_id'), 'console')
        assert.equal(fresh.searchParams.get('post_logout_redirect_uri'), SignOutFixture.SignedOutPage)
        const signIn = await f.SignIn()
        await f.Logout(signIn.Cookie)
        const stale = await f.Logout(signIn.Cookie)
        assert.equal(stale.Status, 200)
        assert.match(stale.Header('set-cookie') ?? '', /Max-Age=0/)
        assert.equal(new URL(SignOutFixture.Redirect(stale)).searchParams.get('id_token_hint'), null)
    })

    it('an application that retains no tokens sends no hint', async () =>
    {
        f = await new SignOutFixture().Start({ Retain: false })
        const signIn = await f.SignIn()
        const redirect = new URL(SignOutFixture.Redirect(await f.Logout(signIn.Cookie)))
        assert.equal(redirect.searchParams.get('id_token_hint'), null)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 401)
    })

    it('sign-in and sign-out share one discovery read; a later read follows the discovery cache TTL', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        await f.Logout(signIn.Cookie)
        await f.Logout()
        assert.equal(f.Http.DiscoveryFetches, 1)
        f.Clock.OffsetMs = 400_000
        await f.Logout()
        assert.equal(f.Http.DiscoveryFetches, 2)
    })

    it('does not refresh the tokens at logout: a due, refreshable access token still sends the stored ID token as the hint', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn(idToken => ({ id_token: idToken, access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 }))
        const posted = f.Http.Inner.PostedFields.length
        f.Clock.OffsetMs = 45_000
        const redirect = new URL(SignOutFixture.Redirect(await f.Logout(signIn.Cookie)))
        assert.equal(redirect.searchParams.get('id_token_hint'), signIn.IdToken)
        assert.equal(f.Http.Inner.PostedFields.length, posted)
    })

    it('a token store that fails the read sends no hint, and still signs out', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        f.Repository.FailFind = true
        const out = await f.Logout(signIn.Cookie)
        assert.equal(out.Status, 200)
        assert.equal(new URL(SignOutFixture.Redirect(out)).searchParams.get('id_token_hint'), null)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 401)
    })

    it('a failed revocation or token deletion is logged (never the token) and the answer still signs out', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        const bearer = signIn.Cookie.split('=')[1] as string
        f.Host.Sessions.Revoke = async () => { throw new Error('session store unreachable') }
        f.Repository.FailDelete = true
        const out = await f.Logout(signIn.Cookie)
        assert.equal(out.Status, 200)
        assert.equal(out.Header('cache-control'), 'no-store')
        assert.match(out.Header('set-cookie') ?? '', /Max-Age=0/)
        assert.equal(new URL(SignOutFixture.Redirect(out)).searchParams.get('id_token_hint'), signIn.IdToken)
        assert.ok(f.Logged.some(line => line.includes('session store unreachable')))
        assert.ok(f.Logged.some(line => line.includes('token store unreachable')))
        assert.ok(f.Logged.every(line => !line.includes(signIn.IdToken) && !line.includes(bearer)))
    })

    it('a discovery failure after sign-in logs no token', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        const bearer = signIn.Cookie.split('=')[1] as string
        f.Http.FailDiscovery = true
        f.Clock.OffsetMs = 400_000
        assert.equal(SignOutFixture.Redirect(await f.Logout(signIn.Cookie)), SignOutFixture.SignedOutPage)
        assert.ok(f.Logged.some(line => line.includes('discovery unreachable')))
        assert.ok(f.Logged.every(line => !line.includes(signIn.IdToken) && !line.includes(bearer)))
    })

    it('lands on PostLogoutRedirectUri when the IdP names no end-session endpoint; the session still ends', async () =>
    {
        f = await new SignOutFixture().Start({ EndSession: null })
        const signIn = await f.SignIn()
        const out = await f.Logout(signIn.Cookie)
        assert.equal(out.Status, 200)
        assert.equal(SignOutFixture.Redirect(out), SignOutFixture.SignedOutPage)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 401)
        assert.ok(f.Logged.some(line => line.includes('end_session_endpoint')))
    })

    it('ignores an end-session endpoint that is not https', async () =>
    {
        f = await new SignOutFixture().Start({ EndSession: 'http://idp.test/tenant/logout' })
        assert.equal(SignOutFixture.Redirect(await f.Logout()), SignOutFixture.SignedOutPage)
    })

    it('without PostLogoutRedirectUri: no post_logout_redirect_uri, and / when there is no end-session endpoint', async () =>
    {
        f = await new SignOutFixture().Start({ Endpoint: { PostLogoutRedirectUri: undefined } })
        const redirect = new URL(SignOutFixture.Redirect(await f.Logout()))
        assert.equal(redirect.searchParams.get('post_logout_redirect_uri'), null)
        assert.equal(redirect.searchParams.get('client_id'), 'console')
        await f.Logout()
        assert.equal(f.Logged.filter(line => line.includes('PostLogoutRedirectUri')).length, 1)
        await f.Host.Stop()
        f = await new SignOutFixture().Start({ EndSession: null, Endpoint: { PostLogoutRedirectUri: undefined } })
        assert.equal(SignOutFixture.Redirect(await f.Logout()), '/')
    })

    it('after a failed discovery waits out the backoff, then reads it again and recovers', async () =>
    {
        f = await new SignOutFixture().Start()
        f.Http.FailDiscovery = true
        assert.equal(SignOutFixture.Redirect(await f.Logout()), SignOutFixture.SignedOutPage)
        assert.ok(f.Logged.some(line => line.includes('discovery unreachable')))
        const fetches = f.Http.DiscoveryFetches
        f.Http.FailDiscovery = false
        assert.equal(SignOutFixture.Redirect(await f.Logout()), SignOutFixture.SignedOutPage)
        assert.equal(f.Http.DiscoveryFetches, fetches)
        f.Clock.OffsetMs = OidcSignOut.FailureBackoffMs + 1
        const redirect = new URL(SignOutFixture.Redirect(await f.Logout()))
        assert.equal(redirect.origin + redirect.pathname, f.Idp.Issuer + '/logout')
    })

    it('a provider that refuses the request still signs out locally, to the signed-out page', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        f.Clients.Refuse = true
        const out = await f.Logout(signIn.Cookie)
        assert.equal(out.Status, 200)
        assert.equal(SignOutFixture.Redirect(out), SignOutFixture.SignedOutPage)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 401)
    })

    it('refuses a cross-origin logout and keeps the session', async () =>
    {
        f = await new SignOutFixture().Start()
        const signIn = await f.SignIn()
        assert.equal((await f.Host.Send('/api/logout', { Method: 'POST', Cookie: signIn.Cookie, Origin: 'http://evil.example' })).Status, 403)
        assert.equal((await f.Host.Send('/api/session', { Cookie: signIn.Cookie })).Status, 200)
    })

    it('refuses a PostLogoutRedirectUri that is not an absolute http(s) URL', async () =>
    {
        f = await new SignOutFixture().Start()
        const rp = new OidcRelyingParty(new InMemoryOidcFlowStateStore())
        for (const uri of ['/signed-out', 'javascript:alert(1)', 'not a url'])
        {
            assert.throws(() => new OidcLoginEndpoint(rp, f.Clients, f.Host.Gate, { PostLogoutRedirectUri: uri }), /^Error: OidcSignOut: PostLogoutRedirectUri/, uri)
        }
    })
})
