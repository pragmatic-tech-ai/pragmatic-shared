import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { AgentChannelHost } from '../agent-channel-host.js'
import { AgentChannelOperation, AgentChannelReplies, type AgentChannelReply, type AgentChannelRequest, type IAgentChannelBackend } from '../agent-channel-backend.js'
import { PlaneHttp } from '../plane-http.js'

/** One HTTP answer as the client saw it. */
interface ChannelReply
{
    Status: number
    Headers: Record<string, string | string[] | undefined>
    Text: string
}

/** A backend that records every call and answers with a settable reply (or fails when told to). */
class FakeChannelBackend implements IAgentChannelBackend
{
    public readonly Requests: AgentChannelRequest[] = []
    public Reply: AgentChannelReply = { Status: 200, Body: { ok: true } }
    public Failure: Error | undefined
    public Console = true

    public async Handle(request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        this.Requests.push(request)
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return this.Reply
    }

    public ServesConsole(): boolean
    {
        return this.Console
    }
}

/** A listening host over a fake backend, plus a tiny HTTP client to drive it. */
class ChannelFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly HiveId = 'h1'
    public static readonly Token = 'secret-bearer-token'
    public static readonly BearerPrefix = 'Bearer '
    public static readonly Bearer = ChannelFixture.BearerPrefix + ChannelFixture.Token
    public static readonly AuthorizationHeader = 'authorization'
    public static readonly ContentTypeHeader = 'content-type'
    public static readonly ConnectionHeader = 'connection'
    public static readonly JsonType = 'application/json'
    public static readonly CloseValue = 'close'
    public static readonly Utf8 = 'utf8'
    public static readonly MethodDelete = 'DELETE'
    public static readonly HivesPrefix = '/agent/hives/'
    public static readonly Slash = '/'
    public static readonly MaxBodyBytes = 1048576
    public static readonly EmptyJson = '{}'
    public static readonly NotFoundBody = { error: PlaneHttp.NotFoundMessage }
    public static readonly BadNameBody = { error: 'Invalid hive id in path' }
    public static readonly TooLargeBody = { error: 'Request body too large' }
    public static readonly InternalBody = { error: 'Internal error' }
    public static readonly GetOperations: readonly AgentChannelOperation[] = [AgentChannelOperation.Target, AgentChannelOperation.Adoptable, AgentChannelOperation.Status, AgentChannelOperation.Ledger]
    public static readonly PostOperations: readonly AgentChannelOperation[] = [AgentChannelOperation.Snapshot, AgentChannelOperation.Adopt, AgentChannelOperation.Console, AgentChannelOperation.ConsoleVerifyDomain]
    public static readonly ConsoleOperations: readonly AgentChannelOperation[] = [AgentChannelOperation.Console, AgentChannelOperation.ConsoleVerifyDomain]

    public readonly Backend = new FakeChannelBackend()
    public readonly Host = new AgentChannelHost(this.Backend)

    /** Starts a host, runs the scenario against it, and always closes it. */
    public static async Run(scenario: (f: ChannelFixture) => Promise<void>, console = true): Promise<void>
    {
        const f = new ChannelFixture()
        f.Backend.Console = console
        await f.Host.Listen(0, ChannelFixture.Loopback)
        try
        {
            await scenario(f)
        }
        finally
        {
            await f.Host.Close()
        }
    }

    public static PathOf(operation: string, hiveId: string = ChannelFixture.HiveId): string
    {
        return ChannelFixture.HivesPrefix + hiveId + ChannelFixture.Slash + operation
    }

    public static MethodOf(operation: AgentChannelOperation): string
    {
        return ChannelFixture.PostOperations.includes(operation) ? PlaneHttp.MethodPost : PlaneHttp.MethodGet
    }

    public static Json(reply: ChannelReply): unknown
    {
        return JSON.parse(reply.Text)
    }

    /** Sends one request; a null authorization sends no Authorization header at all. */
    public Send(method: string, path: string, authorization: string | null = ChannelFixture.Bearer, body?: string): Promise<ChannelReply>
    {
        const headers: Record<string, string> = { [ChannelFixture.ContentTypeHeader]: ChannelFixture.JsonType }
        if (authorization !== null)
        {
            headers[ChannelFixture.AuthorizationHeader] = authorization
        }
        const addr = this.Host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve({ Status: res.statusCode ?? 0, Headers: res.headers, Text: Buffer.concat(chunks).toString(ChannelFixture.Utf8) }))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('AgentChannelHost', () =>
{
    it('routes every GET operation to the backend with the hive id and bearer token, no body and no query', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            for (const op of ChannelFixture.GetOperations)
            {
                const reply = await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(op))
                assert.equal(reply.Status, 200, op)
                assert.deepEqual(ChannelFixture.Json(reply), { ok: true })
            }
            assert.deepEqual(f.Backend.Requests, ChannelFixture.GetOperations.map(op => ({ Operation: op, HiveId: ChannelFixture.HiveId, Token: ChannelFixture.Token, Body: undefined, Query: undefined })))
        })
    })

    it('routes every POST operation to the backend with the raw body text', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            const raw = '{"a": 1,  "b":"x"}'
            for (const op of ChannelFixture.PostOperations)
            {
                assert.equal((await f.Send(PlaneHttp.MethodPost, ChannelFixture.PathOf(op), ChannelFixture.Bearer, raw)).Status, 200, op)
            }
            assert.deepEqual(f.Backend.Requests.map(r => [r.Operation, r.Body]), ChannelFixture.PostOperations.map(op => [op, raw]))
        })
    })

    it('hands an empty POST body over as the empty string', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            await f.Send(PlaneHttp.MethodPost, ChannelFixture.PathOf(AgentChannelOperation.Snapshot))
            assert.equal(f.Backend.Requests[0]?.Body, '')
        })
    })

    it('passes the query string as a record and decodes the hive id', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Ledger, 'my%20hive') + '?limit=5&kind=a%26b')
            assert.deepEqual(f.Backend.Requests[0], { Operation: AgentChannelOperation.Ledger, HiveId: 'my hive', Token: ChannelFixture.Token, Body: undefined, Query: { limit: '5', kind: 'a&b' } })
        })
    })

    it('answers 404 for any other path or method and never asks the backend', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            const misses: Array<[string, string]> = [
                [PlaneHttp.MethodGet, ChannelFixture.Slash],
                [PlaneHttp.MethodGet, '/agent/hives/h1'],
                [PlaneHttp.MethodGet, '/agent/hives/h1/unknown'],
                [PlaneHttp.MethodGet, '/agent/hives/h1/target/extra'],
                [PlaneHttp.MethodGet, '/agent/hives//target'],
                [PlaneHttp.MethodGet, '/api/agent/hives/h1/target'],
                [ChannelFixture.MethodDelete, ChannelFixture.PathOf(AgentChannelOperation.Snapshot)],
            ]
            for (const op of [...ChannelFixture.GetOperations, ...ChannelFixture.PostOperations])
            {
                misses.push([ChannelFixture.MethodOf(op) === PlaneHttp.MethodGet ? PlaneHttp.MethodPost : PlaneHttp.MethodGet, ChannelFixture.PathOf(op)])
            }
            for (const [method, path] of misses)
            {
                const reply = await f.Send(method, path, ChannelFixture.Bearer, method === PlaneHttp.MethodPost ? ChannelFixture.EmptyJson : undefined)
                assert.equal(reply.Status, 404, method + ' ' + path)
                assert.deepEqual(ChannelFixture.Json(reply), ChannelFixture.NotFoundBody)
            }
            assert.equal(f.Backend.Requests.length, 0)
        })
    })

    it('does not mount the console routes when the backend does not serve them', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            for (const op of ChannelFixture.ConsoleOperations)
            {
                assert.equal((await f.Send(PlaneHttp.MethodPost, ChannelFixture.PathOf(op), ChannelFixture.Bearer, ChannelFixture.EmptyJson)).Status, 404, op)
            }
            assert.equal((await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Target))).Status, 200)
            assert.deepEqual(f.Backend.Requests.map(r => r.Operation), [AgentChannelOperation.Target])
        }, false)
    })

    it('answers 401 for a missing, non-bearer or malformed authorization header and never asks the backend', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            for (const auth of [null, 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer a b', 'bearer ' + ChannelFixture.Token, ChannelFixture.Token])
            {
                for (const op of [AgentChannelOperation.Target, AgentChannelOperation.Snapshot])
                {
                    const reply = await f.Send(ChannelFixture.MethodOf(op), ChannelFixture.PathOf(op), auth, ChannelFixture.MethodOf(op) === PlaneHttp.MethodPost ? ChannelFixture.EmptyJson : undefined)
                    assert.equal(reply.Status, AgentChannelReplies.Unauthorized.Status, String(auth))
                    assert.deepEqual(ChannelFixture.Json(reply), AgentChannelReplies.Unauthorized.Body)
                }
            }
            assert.equal(f.Backend.Requests.length, 0)
        })
    })

    it('answers 400 for an undecodable hive id, before the bearer check, and never asks the backend', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            for (const auth of [ChannelFixture.Bearer, null])
            {
                const reply = await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Target, '%E0%A4%A'), auth)
                assert.equal(reply.Status, 400)
                assert.deepEqual(ChannelFixture.Json(reply), ChannelFixture.BadNameBody)
            }
            assert.equal(f.Backend.Requests.length, 0)
        })
    })

    it('accepts a body of exactly the cap and answers 413 with Connection: close one byte over, never asking the backend', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            const path = ChannelFixture.PathOf(AgentChannelOperation.Snapshot)
            assert.equal((await f.Send(PlaneHttp.MethodPost, path, ChannelFixture.Bearer, 'x'.repeat(ChannelFixture.MaxBodyBytes))).Status, 200)
            assert.equal(f.Backend.Requests[0]?.Body?.length, ChannelFixture.MaxBodyBytes)
            const reply = await f.Send(PlaneHttp.MethodPost, path, ChannelFixture.Bearer, 'x'.repeat(ChannelFixture.MaxBodyBytes + 1))
            assert.equal(reply.Status, 413)
            assert.equal(reply.Headers[ChannelFixture.ConnectionHeader], ChannelFixture.CloseValue)
            assert.deepEqual(ChannelFixture.Json(reply), ChannelFixture.TooLargeBody)
            assert.ok(!reply.Text.includes(ChannelFixture.Token))
            assert.equal(f.Backend.Requests.length, 1)
            assert.equal((await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Target))).Status, 200, 'the host still serves after shedding')
        })
    })

    it('writes the backend reply verbatim: status plus JSON body, or no body at all', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            f.Backend.Reply = { Status: 403, Body: { error: 'Forbidden', detail: [1, 2] } }
            const json = await f.Send(PlaneHttp.MethodPost, ChannelFixture.PathOf(AgentChannelOperation.Adopt), ChannelFixture.Bearer, ChannelFixture.EmptyJson)
            assert.equal(json.Status, 403)
            assert.equal(json.Headers[ChannelFixture.ContentTypeHeader], PlaneHttp.JsonType)
            assert.deepEqual(ChannelFixture.Json(json), { error: 'Forbidden', detail: [1, 2] })
            f.Backend.Reply = { Status: 204 }
            const empty = await f.Send(PlaneHttp.MethodPost, ChannelFixture.PathOf(AgentChannelOperation.Snapshot), ChannelFixture.Bearer, ChannelFixture.EmptyJson)
            assert.equal(empty.Status, 204)
            assert.equal(empty.Text, '')
            assert.equal(empty.Headers[ChannelFixture.ContentTypeHeader], undefined)
            f.Backend.Reply = AgentChannelReplies.Unauthorized
            const refused = await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Status))
            assert.equal(refused.Status, 401)
            assert.deepEqual(ChannelFixture.Json(refused), AgentChannelReplies.Unauthorized.Body)
        })
    })

    it('answers 500 with a fixed body when the backend throws, logging the error name only', async () =>
    {
        const logged: unknown[][] = []
        const original = console.error
        console.error = (...a: unknown[]) => { logged.push(a) }
        try
        {
            await ChannelFixture.Run(async f =>
            {
                f.Backend.Failure = new TypeError('leaks ' + ChannelFixture.Token)
                const reply = await f.Send(PlaneHttp.MethodGet, ChannelFixture.PathOf(AgentChannelOperation.Target))
                assert.equal(reply.Status, 500)
                assert.deepEqual(ChannelFixture.Json(reply), ChannelFixture.InternalBody)
                assert.ok(!reply.Text.includes(ChannelFixture.Token))
            })
        }
        finally
        {
            console.error = original
        }
        assert.deepEqual(logged, [['[agent-channel]', 'TypeError']])
    })

    it('IsChannelPath recognises the eight routes (any method, query ignored) and nothing else', () =>
    {
        for (const op of [...ChannelFixture.GetOperations, ...ChannelFixture.PostOperations])
        {
            assert.equal(AgentChannelHost.IsChannelPath(ChannelFixture.PathOf(op)), true, op)
        }
        assert.equal(AgentChannelHost.IsChannelPath(ChannelFixture.PathOf(AgentChannelOperation.Ledger) + '?limit=3'), true)
        for (const miss of [undefined, '', ChannelFixture.Slash, '/agent/hives/h1', '/agent/hives/h1/unknown', '/agent/hives/h1/target/', '/x/agent/hives/h1/target'])
        {
            assert.equal(AgentChannelHost.IsChannelPath(miss), false, String(miss))
        }
    })

    it('Address throws until listening and after Close; Close is idempotent', async () =>
    {
        const host = new AgentChannelHost(new FakeChannelBackend())
        assert.throws(() => host.Address(), /not listening/)
        await host.Listen(0, ChannelFixture.Loopback)
        assert.equal(host.Address().address, ChannelFixture.Loopback)
        assert.ok(host.Address().port > 0)
        await host.Close()
        assert.throws(() => host.Address(), /not listening/)
        await host.Close()
    })

    it('Listen rejects when the port is already taken', async () =>
    {
        await ChannelFixture.Run(async f =>
        {
            const second = new AgentChannelHost(new FakeChannelBackend())
            await assert.rejects(second.Listen(f.Host.Address().port, ChannelFixture.Loopback))
            assert.throws(() => second.Address(), /not listening/)
        })
    })
})
