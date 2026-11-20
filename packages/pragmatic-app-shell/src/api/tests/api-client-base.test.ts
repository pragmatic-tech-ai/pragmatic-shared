import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiClientBase } from '../api-client-base.js'
import { ApiError } from '../api-error.js'
import { AppShellConfig } from '../../config/app-shell-config.js'
import { FetchStub } from '../../tests/support.js'

// A concrete client: the base's verbs exposed for the test.
class ProbeClient extends ApiClientBase
{
    public constructor(fetch: FetchStub, basePath: string = '')
    {
        super(new AppShellConfig({ ProductName: 'Probe', ApiBasePath: basePath }), fetch.Fetch)
    }

    public ReadThing(route: string): Promise<unknown>
    {
        return this.Get(route)
    }

    public CreateThing(route: string, body?: unknown): Promise<unknown>
    {
        return this.Post(route, body)
    }

    public ReplaceThing(route: string, body: unknown): Promise<unknown>
    {
        return this.Put(route, body)
    }

    public PatchThing(route: string, body: unknown): Promise<unknown>
    {
        return this.Patch(route, body)
    }

    public RemoveThing(route: string): Promise<unknown>
    {
        return this.Delete(route)
    }
}

describe('ApiClientBase', () =>
{
    it('GETs with the own-origin credentials, asks for JSON, sends no body and returns the parsed reply', async () =>
    {
        const fetch = new FetchStub().Json(200, { a: 1 })
        const reply = await new ProbeClient(fetch).ReadThing('/api/things')
        assert.deepEqual(reply, { a: 1 })
        assert.equal(fetch.Last.Url, '/api/things')
        assert.equal(fetch.Last.Init.method, 'GET')
        assert.equal(fetch.Last.Init.credentials, 'same-origin')
        assert.equal(fetch.Last.Init.body, undefined)
        assert.equal(fetch.HeaderOf(0, 'accept'), 'application/json')
        assert.equal(fetch.HeaderOf(0, 'content-type'), undefined)
    })

    it('sends every mutation as JSON, with an empty object when it has no body (the host refuses other types)', async () =>
    {
        const fetch = new FetchStub().Json(200, {})
        const client = new ProbeClient(fetch)
        await client.CreateThing('/api/things', { name: 'x' })
        await client.CreateThing('/api/things')
        await client.ReplaceThing('/api/things/1', { name: 'y' })
        await client.PatchThing('/api/things/1', { name: 'z' })
        await client.RemoveThing('/api/things/1')
        assert.deepEqual(fetch.Calls.map(c => c.Init.method), ['POST', 'POST', 'PUT', 'PATCH', 'DELETE'])
        assert.deepEqual(fetch.Calls.map((_, i) => fetch.BodyOf(i)), [{ name: 'x' }, {}, { name: 'y' }, { name: 'z' }, {}])
        for (let i = 0; i < fetch.Calls.length; i++)
        {
            assert.equal(fetch.HeaderOf(i, 'content-type'), 'application/json')
            assert.equal(fetch.Calls[i].Init.credentials, 'same-origin')
        }
    })

    it('prefixes every route with the configured base path', async () =>
    {
        const fetch = new FetchStub().Json(200, {})
        const client = new ProbeClient(fetch, '/console')
        await client.ReadThing('/api/things')
        assert.equal(fetch.Last.Url, '/console/api/things')
        assert.equal(client.Url('/auth/oidc/begin'), '/console/auth/oidc/begin')
    })

    it('never sends a request off its own origin: a route must be one absolute same-origin path', async () =>
    {
        const fetch = new FetchStub().Json(200, {})
        const client = new ProbeClient(fetch)
        for (const bad of ['api/things', '//evil.example/api', 'https://evil.example/api', '/a\\b', ''])
        {
            await assert.rejects(client.ReadThing(bad), /route/, bad)
        }
        assert.equal(fetch.Calls.length, 0)
    })

    it('answers undefined for 204 and for an OK reply that is not JSON', async () =>
    {
        assert.equal(await new ProbeClient(new FetchStub().Empty(204)).CreateThing('/api/x'), undefined)
        assert.equal(await new ProbeClient(new FetchStub().Text(200, 'ok')).ReadThing('/api/x'), undefined)
    })

    it('throws ApiError with the server error text, code and body for a non-2xx reply', async () =>
    {
        const fetch = new FetchStub().Json(409, { error: 'Already exists', code: 'exists', id: 'a' })
        const error = await new ProbeClient(fetch).CreateThing('/api/things', {}).catch((e: unknown) => e)
        assert.ok(error instanceof ApiError)
        assert.equal(error.Status, 409)
        assert.equal(error.message, 'Already exists')
        assert.equal(error.Code, 'exists')
        assert.deepEqual(error.Body, { error: 'Already exists', code: 'exists', id: 'a' })
        assert.equal(error.IsUnauthorized, false)
        assert.equal(error.IsForbidden, false)
    })

    it('says the status when the failed reply carries no error text', async () =>
    {
        const error = await new ProbeClient(new FetchStub().Text(502, 'Bad gateway')).ReadThing('/api/x').catch((e: unknown) => e)
        assert.ok(error instanceof ApiError)
        assert.equal(error.Status, 502)
        assert.equal(error.message, 'Request failed: 502')
        assert.equal(error.Code, undefined)
    })

    it('signals every 401 on Unauthorized and every 403 on Forbidden before throwing', async () =>
    {
        const fetch = new FetchStub().Json(401, { error: 'Not signed in' }).Json(403, { error: 'Forbidden' })
        const client = new ProbeClient(fetch)
        const unauthorized: number[] = []
        const forbidden: string[] = []
        client.Unauthorized.subscribe(e => { unauthorized.push(e.Status) })
        client.Forbidden.subscribe(e => { forbidden.push(e.message) })
        const first = await client.ReadThing('/api/a').catch((e: unknown) => e)
        const second = await client.CreateThing('/api/b').catch((e: unknown) => e)
        assert.ok(first instanceof ApiError && first.IsUnauthorized)
        assert.ok(second instanceof ApiError && second.IsForbidden)
        assert.deepEqual(unauthorized, [401])
        assert.deepEqual(forbidden, ['Forbidden'])
    })

    it('lets a network failure propagate as it is (no status to report)', async () =>
    {
        const failure = new TypeError('Failed to fetch')
        await assert.rejects(new ProbeClient(new FetchStub().Failing(failure)).ReadThing('/api/x'), failure)
    })
})
