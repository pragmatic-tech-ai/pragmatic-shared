import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppSessionClient } from '../app-session-client.js'
import { ApiError } from '../api-error.js'
import { AppShellConfig, type AppShellOptions } from '../../config/app-shell-config.js'
import { SignInMethod } from '../../config/sign-in-method.js'
import { FakePage, FetchStub } from '../../tests/support.js'

class Kit
{
    public static Client(fetch: FetchStub, options: Partial<AppShellOptions> = {}): AppSessionClient
    {
        return new AppSessionClient(new AppShellConfig({ ProductName: 'Console', ...options }), fetch.Fetch)
    }
}

describe('AppSessionClient', () =>
{
    it('reads the session as subject and claims (the SessionEndpoint reply)', async () =>
    {
        const fetch = new FetchStub().Json(200, { subject: 'u-1', claims: { email: ['a@example.test'], roles: ['viewer', 'admin'] } })
        const session = await Kit.Client(fetch).Session()
        assert.equal(fetch.Last.Url, '/api/session')
        assert.equal(fetch.Last.Init.method, 'GET')
        assert.ok(session !== null)
        assert.equal(session.Subject, 'u-1')
        assert.equal(session.Email, 'a@example.test')
        assert.deepEqual(session.Roles, ['viewer', 'admin'])
    })

    it('answers null without signalling expiry when there is no session (401)', async () =>
    {
        const fetch = new FetchStub().Json(401, { error: 'Not signed in' })
        const client = Kit.Client(fetch)
        let signalled = 0
        client.Unauthorized.subscribe(() => { signalled++ })
        assert.equal(await client.Session(), null)
        assert.equal(signalled, 0)
    })

    it('lets any other session-probe failure propagate', async () =>
    {
        await assert.rejects(Kit.Client(new FetchStub().Json(503, { error: 'Unavailable' })).Session(), (e: unknown) => e instanceof ApiError && e.Status === 503)
    })

    it('signs in with a password at the PasswordLoginEndpoint; a wrong one is an ApiError, not an expiry', async () =>
    {
        const fetch = new FetchStub().Json(200, { subject: 'op' }).Json(401, { error: 'Invalid credentials' })
        const client = Kit.Client(fetch, { SignInMethods: [SignInMethod.Password] })
        let signalled = 0
        client.Unauthorized.subscribe(() => { signalled++ })
        await client.PasswordLogin('op@example.test', 'pw')
        assert.equal(fetch.Calls[0].Url, '/api/login')
        assert.equal(fetch.Calls[0].Init.method, 'POST')
        assert.deepEqual(fetch.BodyOf(0), { email: 'op@example.test', password: 'pw' })
        await assert.rejects(client.PasswordLogin('op@example.test', 'bad'), /Invalid credentials/)
        assert.equal(signalled, 0)
    })

    it('refuses a password sign-in the application does not offer, without a request', async () =>
    {
        const fetch = new FetchStub().Json(200, {})
        await assert.rejects(Kit.Client(fetch).PasswordLogin('a', 'b'), /password sign-in/)
        assert.equal(fetch.Calls.length, 0)
    })

    it('starts OIDC sign-in by navigating to the begin path under the base path', () =>
    {
        const page = new FakePage()
        Kit.Client(new FetchStub(), { ApiBasePath: '/cabinet' }).BeginOidcSignIn(page)
        assert.deepEqual(page.Assigned, ['/cabinet/auth/oidc/begin'])
    })

    it('refuses OIDC sign-in when the application offers only a password', () =>
    {
        assert.throws(() => Kit.Client(new FetchStub(), { SignInMethods: [SignInMethod.Password] }).BeginOidcSignIn(new FakePage()), /OIDC sign-in/)
    })

    it('logs out with a POST (the public, Origin-guarded logout route)', async () =>
    {
        const fetch = new FetchStub().Empty(204)
        await Kit.Client(fetch).Logout()
        assert.equal(fetch.Last.Url, '/api/logout')
        assert.equal(fetch.Last.Init.method, 'POST')
        assert.deepEqual(fetch.BodyOf(0), {})
    })

    it('mints a WebSocket ticket with a POST and builds the socket URL on the page origin', async () =>
    {
        const fetch = new FetchStub().Json(200, { ticket: 't-1' })
        const client = Kit.Client(fetch, { ApiBasePath: '/c' })
        assert.equal(await client.MintWsTicket(), 't-1')
        assert.equal(fetch.Last.Url, '/c/api/ws-ticket')
        assert.equal(fetch.Last.Init.method, 'POST')
        assert.equal(client.SocketUrl('/api/events', { protocol: 'https:', host: 'console.example' }), 'wss://console.example/c/api/events')
        assert.equal(client.SocketUrl('/api/events', { protocol: 'http:', host: 'localhost:8080' }), 'ws://localhost:8080/c/api/events')
    })

    it('changes the own password at the configured path; without one it refuses', async () =>
    {
        const fetch = new FetchStub().Json(200, { ok: true, otherSessionsEnded: true })
        const client = Kit.Client(fetch, { Paths: { ChangePassword: '/api/session/password' } })
        assert.equal(client.ChangesPassword, true)
        assert.deepEqual(await client.ChangeOwnPassword('old', 'new-password-1', 'new-password-1'), { ok: true, otherSessionsEnded: true })
        assert.equal(fetch.Last.Url, '/api/session/password')
        assert.deepEqual(fetch.BodyOf(0), { currentPassword: 'old', newPassword: 'new-password-1', confirmPassword: 'new-password-1' })
        const without = Kit.Client(new FetchStub())
        assert.equal(without.ChangesPassword, false)
        await assert.rejects(without.ChangeOwnPassword('a', 'b', 'b'), /change-password path/)
    })
})
