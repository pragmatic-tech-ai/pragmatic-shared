import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { SessionEndpoint } from '../session-endpoint.js'
import type { ISignOutDestination } from '../session-endpoint.js'
import { WsTicketEndpoint } from '../ws-ticket-endpoint.js'
import { WsTicketStore } from '../../session/ws-ticket-store.js'
import { InMemoryTicketRepository } from '../../session/ticket-repository.js'
import { RouteAuth } from '../../routing/route.js'

class SocketProbe
{
    /** Opens a socket and resolves with the first message, or 'refused' when the upgrade is refused. */
    public static Open(port: number, path: string, protocols: string[], origin: string): Promise<string>
    {
        return new Promise(resolve =>
        {
            const ws = new WebSocket(`ws://localhost:${port}${path}`, protocols, { headers: { origin } })
            ws.on('message', data =>
            {
                resolve(String(data))
                ws.close()
            })
            ws.on('error', () => resolve('refused'))
            ws.on('unexpected-response', () => resolve('refused'))
        })
    }
}

describe('SessionEndpoint', () =>
{
    let fixture: HostFixture

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        new SessionEndpoint(fixture.Gate).Register(fixture.Routes)
        await fixture.Start()
    })

    afterEach(async () => await fixture.Stop())

    it('GET /api/session returns the subject and claims, no-store; 401 without a session', async () =>
    {
        const cookie = await fixture.SignIn('alice', ['app.admin'], { email: 'a@x' })
        const answer = await fixture.Send('/api/session', { Cookie: cookie })
        assert.equal(answer.Status, 200)
        assert.deepEqual(answer.Json(), { subject: 'alice', claims: { email: ['a@x'], roles: ['app.admin'] } })
        assert.equal(answer.Header('cache-control'), 'no-store')
        assert.equal((await fixture.Send('/api/session')).Status, 401)
    })

    it('POST /api/logout revokes the session and clears the cookie; without a cookie it still clears', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        const answer = await fixture.Send('/api/logout', { Method: 'POST', Cookie: cookie })
        assert.equal(answer.Status, 204)
        assert.match(answer.Header('set-cookie') ?? '', /^app_session=;.*Max-Age=0/)
        assert.equal((await fixture.Send('/api/session', { Cookie: cookie })).Status, 401)
        assert.equal((await fixture.Send('/api/logout', { Method: 'POST' })).Status, 204)
    })

    it('logout from a foreign Origin is refused (it is a mutation)', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        assert.equal((await fixture.Send('/api/logout', { Method: 'POST', Cookie: cookie, Origin: 'http://evil.example' })).Status, 403)
        assert.equal((await fixture.Send('/api/session', { Cookie: cookie })).Status, 200)
    })
})

/** A sign-out destination that cannot answer. */
class RejectingDestination implements ISignOutDestination
{
    public readonly SignedOut = 'https://console.example/signed-out'

    public async For(): Promise<string>
    {
        throw new Error('destination unreachable')
    }
}

describe('SessionEndpoint with a sign-out destination', () =>
{
    let fixture: HostFixture
    const logged: string[] = []

    beforeEach(async () =>
    {
        logged.length = 0
        fixture = new HostFixture()
        new SessionEndpoint(fixture.Gate, { SignOut: new RejectingDestination(), Log: (message, err) => { logged.push(message + ' ' + String(err)) } }).Register(fixture.Routes)
        await fixture.Start()
    })

    afterEach(async () => await fixture.Stop())

    it('a destination that rejects still ends the session, clears the cookie and answers its signed-out page, no-store', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        const answer = await fixture.Send('/api/logout', { Method: 'POST', Cookie: cookie })
        assert.equal(answer.Status, 200)
        assert.deepEqual(answer.Json(), { redirect: 'https://console.example/signed-out' })
        assert.equal(answer.Header('cache-control'), 'no-store')
        assert.match(answer.Header('set-cookie') ?? '', /^app_session=;.*Max-Age=0/)
        assert.equal((await fixture.Send('/api/session', { Cookie: cookie })).Status, 401)
        assert.ok(logged.some(line => line.includes('destination unreachable')))
    })
})

describe('WsTicketEndpoint and socket upgrades', () =>
{
    let fixture: HostFixture
    let tickets: WsTicketStore

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        tickets = new WsTicketStore(new InMemoryTicketRepository())
        new WsTicketEndpoint(tickets).Register(fixture.Routes)
        fixture.Routes.AddSocket({ Pattern: '/api/events', Auth: RouteAuth.Session, Handler: (ws, ctx) => ws.send('hello ' + ctx.Session?.Subject) })
        fixture.Routes.AddSocket({ Pattern: '/api/admin-events', Auth: RouteAuth.Session, Role: 'app.admin', Handler: ws => ws.send('admin') })
        fixture.Routes.AddSocket({ Pattern: '/api/public', Auth: RouteAuth.Public, Handler: ws => ws.send('public') })
        await fixture.Start({}, { Tickets: tickets })
    })

    afterEach(async () => await fixture.Stop())

    it('a signed-in subject mints a ticket and opens the socket with it as the subprotocol, once', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        const minted = await fixture.Send('/api/ws-ticket', { Method: 'POST', Cookie: cookie })
        assert.equal(minted.Status, 200)
        const ticket = String(minted.Json().ticket)
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/events', [ticket], fixture.Origin), 'hello alice')
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/events', [ticket], fixture.Origin), 'refused')
    })

    it('minting needs a session', async () =>
    {
        assert.equal((await fixture.Send('/api/ws-ticket', { Method: 'POST' })).Status, 401)
    })

    it('refuses an upgrade without a ticket, from a foreign Origin, on an unknown path, or without the route role', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        const mint = async (): Promise<string> => String((await fixture.Send('/api/ws-ticket', { Method: 'POST', Cookie: cookie })).Json().ticket)
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/events', [], fixture.Origin), 'refused')
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/events', [await mint()], 'http://evil.example'), 'refused')
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/nope', [await mint()], fixture.Origin), 'refused')
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/admin-events', [await mint()], fixture.Origin), 'refused')
    })

    it('a ticket of a revoked session is refused', async () =>
    {
        const cookie = await fixture.SignIn('alice', [])
        const ticket = String((await fixture.Send('/api/ws-ticket', { Method: 'POST', Cookie: cookie })).Json().ticket)
        await fixture.Sessions.RevokeSubject('alice')
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/events', [ticket], fixture.Origin), 'refused')
    })

    it('a public socket needs no ticket', async () =>
    {
        assert.equal(await SocketProbe.Open(fixture.Port, '/api/public', [], fixture.Origin), 'public')
    })
})
