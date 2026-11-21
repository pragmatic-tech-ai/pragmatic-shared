import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DiscoveryReply, IDesktopDiscoveryBackend } from '../desktop-discovery-contract.js'
import { DesktopDiscoveryEndpoint } from '../desktop-discovery-endpoint.js'
import { PlaneHttp } from '../plane-http.js'

/** One HTTP answer as the client saw it. */
interface DiscoveryAnswer
{
    Status: number
    Body: unknown
    RetryAfter: string | undefined
    ContentType: string | undefined
}

/** A backend that records every email it is asked about and answers with a settable reply. */
class FakeDiscoveryBackend implements IDesktopDiscoveryBackend
{
    public readonly Asked: string[] = []
    public Reply: DiscoveryReply = { Status: 404, Body: { error: 'no-account' } }

    public async Discover(email: string): Promise<DiscoveryReply>
    {
        this.Asked.push(email)
        return this.Reply
    }
}

/** A hand-driven clock for the throttle. */
class FakeClock
{
    public Now = 1_000_000

    public Advance(ms: number): void
    {
        this.Now += ms
    }
}

/** A plain http server whose every request goes through one endpoint, as the address the fixture names. */
class DiscoveryFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly AddressA = '198.51.100.7'
    public static readonly AddressB = '198.51.100.8'
    public static readonly Ann = 'ann@acme.test'
    public static readonly EvilOrigin = 'http://evil.test'
    public static readonly OriginHeader = 'origin'
    public static readonly RetryAfterHeader = 'retry-after'
    public static readonly ContentTypeHeader = 'content-type'
    public static readonly Utf8 = 'utf8'
    public static readonly MaxEmailLength = 254
    public static readonly MaxBodyBytes = 4096
    public static readonly ForbiddenBody = { error: 'forbidden' }
    public static readonly TooManyBody = { error: 'too-many-requests' }
    public static readonly InvalidEmailBody = { error: 'invalid-email' }
    public static readonly LockoutSeconds = '60'
    public static readonly NotJson = 'not json'

    public readonly Backend = new FakeDiscoveryBackend()
    public readonly Clock = new FakeClock()
    public readonly Endpoint = new DesktopDiscoveryEndpoint(this.Backend, DesktopDiscoveryEndpoint.NewThrottle(() => this.Clock.Now))
    /** The client address the next requests are attributed to; undefined uses the endpoint's own default (the socket address). */
    public Address: string | undefined = DiscoveryFixture.AddressA
    private readonly server: Server = createServer((req, res) =>
    {
        void (this.Address === undefined ? this.Endpoint.Handle(req, res) : this.Endpoint.Handle(req, res, this.Address))
    })

    /** Starts a server, runs the scenario against it, and always closes it. */
    public static async Run(scenario: (f: DiscoveryFixture) => Promise<void>): Promise<void>
    {
        const f = new DiscoveryFixture()
        await new Promise<void>(r => f.server.listen(0, DiscoveryFixture.Loopback, r))
        try
        {
            await scenario(f)
        }
        finally
        {
            f.server.closeAllConnections()
            await new Promise<void>(r => f.server.close(() => r()))
        }
    }

    public static Email(email: unknown): string
    {
        return JSON.stringify({ email })
    }

    public Post(payload: string, headers: Record<string, string> = {}, path: string = DesktopDiscoveryEndpoint.Path): Promise<DiscoveryAnswer>
    {
        const port = (this.server.address() as AddressInfo).port
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: DiscoveryFixture.Loopback, port, method: PlaneHttp.MethodPost, path, headers: { [DiscoveryFixture.ContentTypeHeader]: PlaneHttp.JsonType, ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString(DiscoveryFixture.Utf8)
                    resolve({
                        Status: res.statusCode ?? 0,
                        Body: text.length === 0 ? undefined : JSON.parse(text),
                        RetryAfter: res.headers[DiscoveryFixture.RetryAfterHeader] as string | undefined,
                        ContentType: res.headers[DiscoveryFixture.ContentTypeHeader],
                    })
                })
            })
            req.on('error', reject)
            req.end(payload)
        })
    }

    /** Sends `count` well-formed requests and returns their statuses. */
    public async PostMany(count: number): Promise<number[]>
    {
        const statuses: number[] = []
        for (let i = 0; i < count; i++)
        {
            statuses.push((await this.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status)
        }
        return statuses
    }
}

describe('DesktopDiscoveryEndpoint', () =>
{
    it('exposes its route and the throttle shape it is built for', () =>
    {
        assert.equal(DesktopDiscoveryEndpoint.Path, '/api/desktop/discover')
        assert.equal(DesktopDiscoveryEndpoint.MaxHitsPerWindow, 10)
        assert.equal(DesktopDiscoveryEndpoint.WindowMs, 60000)
    })

    it('asks the backend with the email and writes its reply verbatim as JSON', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            f.Backend.Reply = { Status: 200, Body: { tenants: [{ id: 'acme', displayName: 'Acme' }], tenantPlaneUrl: 'https://plane.test' } }
            const ok = await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))
            assert.equal(ok.Status, 200)
            assert.equal(ok.ContentType, PlaneHttp.JsonType)
            assert.deepEqual(ok.Body, f.Backend.Reply.Body)
            f.Backend.Reply = { Status: 404, Body: { error: 'no-account' } }
            const none = await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))
            assert.equal(none.Status, 404)
            assert.deepEqual(none.Body, { error: 'no-account' })
            assert.equal(none.RetryAfter, undefined)
            assert.deepEqual(f.Backend.Asked, [DiscoveryFixture.Ann, DiscoveryFixture.Ann])
        })
    })

    it('passes the email through untrimmed and accepts exactly 254 characters', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            const longest = 'a'.repeat(DiscoveryFixture.MaxEmailLength)
            assert.equal((await f.Post(DiscoveryFixture.Email(' ' + DiscoveryFixture.Ann))).Status, 404)
            assert.equal((await f.Post(DiscoveryFixture.Email(longest))).Status, 404)
            assert.deepEqual(f.Backend.Asked, [' ' + DiscoveryFixture.Ann, longest])
        })
    })

    it('answers 400 invalid-email for every malformed body and never asks the backend', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            const payloads = [
                '',
                DiscoveryFixture.NotJson,
                'null',
                '"ann@acme.test"',
                '[{"email":"ann@acme.test"}]',
                '{}',
                DiscoveryFixture.Email(5),
                DiscoveryFixture.Email(null),
                DiscoveryFixture.Email(''),
                DiscoveryFixture.Email('   '),
                DiscoveryFixture.Email('a'.repeat(DiscoveryFixture.MaxEmailLength + 1)),
                DiscoveryFixture.Email('x'.repeat(DiscoveryFixture.MaxBodyBytes)),
            ]
            for (const payload of payloads)
            {
                // Every one of these counts against the throttle, so step past the window between them.
                f.Clock.Advance(DesktopDiscoveryEndpoint.WindowMs)
                const reply = await f.Post(payload)
                assert.equal(reply.Status, 400, payload.slice(0, 30))
                assert.deepEqual(reply.Body, DiscoveryFixture.InvalidEmailBody)
            }
            assert.equal(f.Backend.Asked.length, 0)
        })
    })

    it('answers 403 forbidden for any Origin header, never asks the backend, and does not count it against the throttle', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            for (let i = 0; i < DesktopDiscoveryEndpoint.MaxHitsPerWindow + 5; i++)
            {
                const reply = await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann), { [DiscoveryFixture.OriginHeader]: i % 2 === 0 ? DiscoveryFixture.EvilOrigin : 'null' })
                assert.equal(reply.Status, 403)
                assert.deepEqual(reply.Body, DiscoveryFixture.ForbiddenBody)
            }
            assert.equal(f.Backend.Asked.length, 0)
            assert.deepEqual(await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow), new Array(DesktopDiscoveryEndpoint.MaxHitsPerWindow).fill(404))
        })
    })

    it('refuses the 11th request in a window with 429, Retry-After in whole seconds, and no backend call', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            assert.deepEqual(await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow), new Array(DesktopDiscoveryEndpoint.MaxHitsPerWindow).fill(404))
            const refused = await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))
            assert.equal(refused.Status, 429)
            assert.deepEqual(refused.Body, DiscoveryFixture.TooManyBody)
            assert.equal(refused.RetryAfter, DiscoveryFixture.LockoutSeconds)
            assert.equal(f.Backend.Asked.length, DesktopDiscoveryEndpoint.MaxHitsPerWindow)
        })
    })

    it('a refused request is itself counted, so hammering inside the window re-arms the full lockout', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow + 1)
            f.Clock.Advance(DesktopDiscoveryEndpoint.WindowMs / 2)
            const again = await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))
            assert.equal(again.Status, 429)
            assert.equal(again.RetryAfter, DiscoveryFixture.LockoutSeconds)
            assert.equal(f.Backend.Asked.length, DesktopDiscoveryEndpoint.MaxHitsPerWindow)
        })
    })

    it('counts a malformed body against the throttle', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            for (let i = 0; i < DesktopDiscoveryEndpoint.MaxHitsPerWindow; i++)
            {
                assert.equal((await f.Post(DiscoveryFixture.NotJson)).Status, 400)
            }
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 429)
            assert.equal(f.Backend.Asked.length, 0)
        })
    })

    it('throttles per address: another address is still served', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow)
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 429)
            f.Address = DiscoveryFixture.AddressB
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 404)
            f.Address = DiscoveryFixture.AddressA
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 429)
        })
    })

    it('serves the address again once the lockout has passed', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow + 1)
            f.Clock.Advance(DesktopDiscoveryEndpoint.WindowMs - 1)
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 429)
            f.Clock.Advance(1)
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 404)
        })
    })

    it('a request spread under the limit across windows is never refused', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            for (let w = 0; w < 3; w++)
            {
                assert.deepEqual(await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow), new Array(DesktopDiscoveryEndpoint.MaxHitsPerWindow).fill(404))
                f.Clock.Advance(DesktopDiscoveryEndpoint.WindowMs)
            }
        })
    })

    it('defaults the client address to the socket remote address', async () =>
    {
        await DiscoveryFixture.Run(async f =>
        {
            f.Address = undefined
            await f.PostMany(DesktopDiscoveryEndpoint.MaxHitsPerWindow)
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 429)
            f.Address = DiscoveryFixture.AddressA
            assert.equal((await f.Post(DiscoveryFixture.Email(DiscoveryFixture.Ann))).Status, 404, 'an explicit address is a different key')
        })
    })
})
