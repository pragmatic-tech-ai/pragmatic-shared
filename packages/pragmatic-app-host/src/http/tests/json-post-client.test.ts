import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { JsonPostClient, JsonPostUnavailableError } from '../json-post-client.js'
import { TestHttp } from '../../tests/support/test-http.js'

class Echo
{
    public static async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const chunks: Buffer[] = []
        for await (const chunk of req)
        {
            chunks.push(chunk as Buffer)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.writeHead(Number(body.status ?? 200), { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: req.url, method: req.method, extra: req.headers['x-extra'], type: req.headers['content-type'], body }))
    }
}

describe('JsonPostClient', () =>
{
    let server: TestHttp | undefined

    afterEach(async () =>
    {
        await server?.Close()
        server = undefined
    })

    it('POSTs JSON with the extra headers, resolving under the base URL', async () =>
    {
        server = await TestHttp.Start((req, res) => Echo.Handle(req, res))
        const client = new JsonPostClient('http://127.0.0.1:' + server.Port + '/base/')
        const reply = await client.Post('/internal/x', { a: 1 }, { 'x-extra': 'yes' })
        assert.equal(reply.Status, 200)
        assert.equal(reply.Ok, true)
        assert.deepEqual(reply.Body, { path: '/internal/x', method: 'POST', extra: 'yes', type: 'application/json', body: { a: 1 } })
    })

    it('returns a non-200 status with its JSON body', async () =>
    {
        server = await TestHttp.Start((req, res) => Echo.Handle(req, res))
        const reply = await new JsonPostClient('http://127.0.0.1:' + server.Port).Post('/x', { status: 409 })
        assert.equal(reply.Status, 409)
        assert.equal(reply.Ok, false)
    })

    it('answers an empty body as undefined', async () =>
    {
        server = await TestHttp.Start((req, res) =>
        {
            req.resume()
            res.writeHead(204)
            res.end()
        })
        const reply = await new JsonPostClient('http://127.0.0.1:' + server.Port).Post('/x', {})
        assert.equal(reply.Status, 204)
        assert.equal(reply.Body, undefined)
    })

    it('fails as unavailable on a reply that is not JSON, too large, too slow, or no server', async () =>
    {
        server = await TestHttp.Start((req, res) =>
        {
            req.resume()
            if (req.url === '/text')
            {
                res.end('not json')
                return
            }
            if (req.url === '/large')
            {
                res.end(JSON.stringify({ x: 'y'.repeat(4096) }))
                return
            }
            setTimeout(() => res.end('{}'), 500)
        })
        const base = 'http://127.0.0.1:' + server.Port
        await assert.rejects(new JsonPostClient(base).Post('/text', {}), JsonPostUnavailableError)
        await assert.rejects(new JsonPostClient(base, 5000, 1024).Post('/large', {}), JsonPostUnavailableError)
        await assert.rejects(new JsonPostClient(base, 50).Post('/slow', {}), JsonPostUnavailableError)
        await assert.rejects(new JsonPostClient('http://127.0.0.1:1').Post('/x', {}), JsonPostUnavailableError)
    })
})
