import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { WebSocket } from 'ws'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { RouteAuth } from '../../routing/route.js'
import { HttpMethod } from '../../http/http-method.js'
import { UpgradeRefusal } from '../../routing/upgrade-refusal.js'

/** A raw HTTP exchange over one TCP connection: what the server wrote until it closed. */
class RawExchange
{
    private static readonly Loopback = '127.0.0.1'

    public static Send(port: number, request: string): Promise<string>
    {
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = []
            const socket = connect(port, RawExchange.Loopback, () => socket.write(request))
            socket.on('data', chunk => chunks.push(chunk))
            socket.on('error', reject)
            socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
            socket.setTimeout(5_000, () => socket.destroy())
        })
    }

    public static Upgrade(path: string, host: string): string
    {
        return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
    }
}

describe('AppHost request edges', () =>
{
    let fixture: HostFixture
    let handled: string[]

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        handled = []
        fixture.Routes.Add({ Method: HttpMethod.Get, Pattern: '/api/ping', Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(200, { ok: true }) })
        fixture.Routes.AddSocket({
            Pattern: '/relay',
            Auth: RouteAuth.Public,
            Admit: async req => req.headers['x-relay-key'] === 'open' ? null : new UpgradeRefusal(401, { error: 'relay refused' }),
            Handler: ws =>
            {
                handled.push('relay')
                ws.send('relayed')
            },
        })
        fixture.Routes.AddSocket({ Pattern: '/plain', Auth: RouteAuth.Public, Handler: ws => ws.send('plain') })
        fixture.Routes.AddSocket({
            Pattern: '/reset',
            Auth: RouteAuth.Public,
            // The client's connection fails while the refusal is written (a reset): an error on the raw socket after Admit.
            Admit: async req =>
            {
                setImmediate(() => req.socket.emit('error', new Error('read ECONNRESET')))
                return new UpgradeRefusal(503, { error: 'unavailable' })
            },
            Handler: () => undefined,
        })
        await fixture.Start()
    })

    afterEach(async () => await fixture.Stop())

    it('an unparseable request target is a 400 with a JSON error, not a 500', async () =>
    {
        const answer = await RawExchange.Send(fixture.Port, `GET // HTTP/1.1\r\nHost: localhost:${fixture.Port}\r\nConnection: close\r\n\r\n`)
        assert.match(answer, /^HTTP\/1\.1 400 /)
        assert.ok(answer.includes('{"error":"Bad request"}'), answer)
        assert.equal((await fixture.Send('/api/ping')).Status, 200)
    })

    it('a socket route whose admission refuses answers plain HTTP with its status and body before any handshake', async () =>
    {
        const answer = await RawExchange.Send(fixture.Port, RawExchange.Upgrade('/relay', 'localhost:' + fixture.Port))
        assert.match(answer, /^HTTP\/1\.1 401 Unauthorized\r\n/)
        assert.match(answer, /content-type: application\/json/i)
        assert.ok(answer.endsWith('{"error":"relay refused"}'), answer)
        assert.deepEqual(handled, [])
    })

    it('a client connection failing during an upgrade is handled by the host (the process does not crash)', async () =>
    {
        await RawExchange.Send(fixture.Port, RawExchange.Upgrade('/reset', 'localhost:' + fixture.Port))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal((await fixture.Send('/api/ping')).Status, 200)
    })

    it('an admitted upgrade proceeds to the handler; a route without Admit is unchanged', async () =>
    {
        assert.equal(await HostSocket.FirstMessage(fixture.Port, '/relay', { 'x-relay-key': 'open' }), 'relayed')
        assert.deepEqual(handled, ['relay'])
        assert.equal(await HostSocket.FirstMessage(fixture.Port, '/plain', {}), 'plain')
    })

    it('admission runs after the Host and Origin checks: a foreign Origin is still destroyed, not answered', async () =>
    {
        const answer = await RawExchange.Send(fixture.Port, RawExchange.Upgrade('/relay', 'localhost:' + fixture.Port).replace('\r\n\r\n', '\r\nOrigin: https://evil.example\r\n\r\n'))
        assert.equal(answer, '')
    })

    it('an admission that throws destroys the socket', async () =>
    {
        await fixture.Stop()
        fixture = new HostFixture()
        fixture.Routes.AddSocket({ Pattern: '/relay', Auth: RouteAuth.Public, Admit: async () => { throw new Error('boom') }, Handler: ws => ws.send('never') })
        await fixture.Start()
        assert.equal(await RawExchange.Send(fixture.Port, RawExchange.Upgrade('/relay', 'localhost:' + fixture.Port)), '')
    })
})

/** Opens a socket and resolves with its first message, or 'refused'. */
class HostSocket
{
    public static FirstMessage(port: number, path: string, headers: Record<string, string>): Promise<string>
    {
        return new Promise(resolve =>
        {
            const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers })
            ws.on('message', data =>
            {
                resolve(String(data))
                ws.close()
            })
            ws.on('error', () => resolve('refused'))
        })
    }
}
