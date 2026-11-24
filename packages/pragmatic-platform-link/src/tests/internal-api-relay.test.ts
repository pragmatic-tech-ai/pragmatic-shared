import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-component'
import { InternalApiClient, InternalApiUnavailableError } from '../internal-api-client.js'
import { InternalApiRoutes } from '../internal-api-routes.js'

/** Admin's internal listener, standing in: records the relayed request, answers what the test sets. */
class AdminStub
{
    public Got: { Url: string, Authorization: string | undefined, ContentType: string | undefined, Body: Buffer } | undefined
    public Answer: (res: ServerResponse) => void = res => res.writeHead(204).end()
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) =>
        {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () =>
            {
                this.Got = { Url: req.url ?? '', Authorization: req.headers.authorization, ContentType: req.headers['content-type'], Body: Buffer.concat(chunks) }
                this.Answer(res)
            })
        })
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
        return 'http://127.0.0.1:' + (this.server!.address() as AddressInfo).port
    }

    public Stop(): Promise<void>
    {
        this.server!.closeAllConnections()
        return new Promise(resolve => this.server!.close(() => resolve()))
    }
}

class RelayFixture
{
    public static readonly Credential = { Bearer: () => 'internal-bearer' } as unknown as InternalApiCredential
}

describe('InternalApiClient.Relay', () =>
{
    const admin = new AdminStub()
    let base = ''

    before(async () =>
    {
        base = await admin.Start()
    })
    after(() => admin.Stop())

    it('the agent exchange route is the documented internal path', () =>
    {
        assert.equal(InternalApiRoutes.AgentExchange, '/internal/v2/agent/exchange')
    })

    it('relays the bytes verbatim with the bearer and answers admin\'s status, bytes and content type', async () =>
    {
        const body = Buffer.from('{"Protocol":1,"weird":"\\u00e9 bytes"}', 'utf8')
        admin.Answer = res => res.writeHead(200, { 'content-type': 'application/json' }).end('{"answer":true}')
        const reply = await new InternalApiClient(base, RelayFixture.Credential).Relay(InternalApiRoutes.AgentExchange, body, 'application/json', 1024)
        assert.equal(admin.Got!.Url, '/internal/v2/agent/exchange')
        assert.equal(admin.Got!.Authorization, 'Bearer internal-bearer')
        assert.equal(admin.Got!.ContentType, 'application/json')
        assert.ok(admin.Got!.Body.equals(body))
        assert.equal(reply.Status, 200)
        assert.equal(reply.Body.toString('utf8'), '{"answer":true}')
        assert.equal(reply.ContentType, 'application/json')
    })

    it('any status resolves, a 204 with an empty body', async () =>
    {
        admin.Answer = res => res.writeHead(204).end()
        const none = await new InternalApiClient(base, RelayFixture.Credential).Relay(InternalApiRoutes.AgentExchange, Buffer.from('{}'), 'application/json', 1024)
        assert.equal(none.Status, 204)
        assert.equal(none.Body.length, 0)
        admin.Answer = res => res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"refused","code":"mismatch"}')
        const refused = await new InternalApiClient(base, RelayFixture.Credential).Relay(InternalApiRoutes.AgentExchange, Buffer.from('{}'), 'application/json', 1024)
        assert.equal(refused.Status, 403)
    })

    it('a reply over the limit, an unreachable admin or a missed deadline rejects', async () =>
    {
        admin.Answer = res => res.writeHead(200).end('x'.repeat(2048))
        await assert.rejects(new InternalApiClient(base, RelayFixture.Credential).Relay(InternalApiRoutes.AgentExchange, Buffer.from('{}'), 'application/json', 1024), InternalApiUnavailableError)
        await assert.rejects(new InternalApiClient('http://127.0.0.1:1', RelayFixture.Credential).Relay(InternalApiRoutes.AgentExchange, Buffer.from('{}'), 'application/json', 1024), InternalApiUnavailableError)
        admin.Answer = () => undefined
        await assert.rejects(new InternalApiClient(base, RelayFixture.Credential, 200).Relay(InternalApiRoutes.AgentExchange, Buffer.from('{}'), 'application/json', 1024), InternalApiUnavailableError)
    })
})
