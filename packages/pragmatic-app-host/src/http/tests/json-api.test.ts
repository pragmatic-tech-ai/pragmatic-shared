import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JsonApi } from '../json-api.js'
import { BodyTooLargeError } from '../body-too-large-error.js'
import { BadRequestProblem } from '../http-problem.js'
import { TestHttp } from '../../tests/support/test-http.js'

test('ReadJson parses a body within the limit; WriteJson answers JSON', async () =>
{
    const http = await TestHttp.Start(async (req, res) => JsonApi.WriteJson(res, 200, { got: await JsonApi.ReadJson(req, 1024) }))
    const answer = await http.Send('/', { Method: 'POST', Body: '{"a":1}', Headers: { 'content-type': 'application/json' } })
    assert.equal(answer.Status, 200)
    assert.deepEqual(answer.Json(), { got: { a: 1 } })
    assert.equal(answer.Header('content-type'), 'application/json; charset=utf-8')
    await http.Close()
})

test('an oversized body is drained before BodyTooLargeError, so the 413 reaches the caller instead of a reset', async () =>
{
    let drained = false
    const http = await TestHttp.Start(async (req, res) =>
    {
        try
        {
            await JsonApi.ReadJson(req, 16)
        }
        catch (err)
        {
            assert.ok(err instanceof BodyTooLargeError)
            drained = req.readableEnded
            JsonApi.WriteJson(res, 413, { error: 'too large' })
        }
    })
    const answer = await http.Send('/', { Method: 'POST', Body: Buffer.alloc(2 * 1024 * 1024, 0x61) })
    assert.equal(answer.Status, 413)
    assert.equal(drained, true)
    await http.Close()
})

test('malformed JSON is a BadRequestProblem; ReadJsonObject also refuses arrays, null and scalars', async () =>
{
    const results: string[] = []
    const http = await TestHttp.Start(async (req, res) =>
    {
        try
        {
            await JsonApi.ReadJsonObject(req, 1024)
            results.push('ok')
        }
        catch (err)
        {
            results.push(err instanceof BadRequestProblem ? 'bad' : 'other')
        }
        res.end()
    })
    for (const body of ['{nope', '[1]', 'null', '7', '{"x":2}'])
    {
        await http.Send('/', { Method: 'POST', Body: body })
    }
    assert.deepEqual(results, ['bad', 'bad', 'bad', 'bad', 'ok'])
    await http.Close()
})

test('an empty body reads as undefined', async () =>
{
    let value: unknown = 'unset'
    const http = await TestHttp.Start(async (req, res) =>
    {
        value = await JsonApi.ReadJson(req, 1024)
        res.end()
    })
    await http.Send('/', { Method: 'POST' })
    assert.equal(value, undefined)
    await http.Close()
})

test('HasBody and IsJson classify requests', async () =>
{
    const seen: Array<[boolean, boolean]> = []
    const http = await TestHttp.Start((req, res) =>
    {
        seen.push([JsonApi.HasBody(req), JsonApi.IsJson(req)])
        JsonApi.Drain(req)
        res.end()
    })
    await http.Send('/', { Method: 'POST', Body: 'x', Headers: { 'content-type': 'Application/JSON; charset=utf-8' } })
    await http.Send('/', { Method: 'POST', Body: 'x', Headers: { 'content-type': 'text/plain' } })
    await http.Send('/', { Method: 'GET' })
    await http.Send('/', { Method: 'POST', Headers: { 'content-length': '0' } })
    assert.deepEqual(seen, [[true, true], [true, false], [false, false], [false, false]])
    await http.Close()
})

test('DeclaredLength reads Content-Length; absent or garbled is undefined', async () =>
{
    const seen: Array<number | undefined> = []
    const http = await TestHttp.Start((req, res) =>
    {
        seen.push(JsonApi.DeclaredLength(req))
        JsonApi.Drain(req)
        res.end()
    })
    await http.Send('/', { Method: 'POST', Body: 'abc', Headers: { 'content-length': '3' } })
    await http.Send('/', { Method: 'GET' })
    assert.deepEqual(seen, [3, undefined])
    await http.Close()
})
