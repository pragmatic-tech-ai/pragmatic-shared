import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProblemMapper } from '../problem-mapper.js'
import { BodyTooLargeError } from '../body-too-large-error.js'
import { BadRequestProblem, HttpProblem } from '../http-problem.js'
import { TestHttp } from '../../tests/support/test-http.js'

class NotThereError extends Error
{
}

class DetailedError extends Error
{
    public readonly Code = 'detail-code'
}

class SecretFailure extends Error
{
}

class UpstreamError extends Error
{
}

class Probe
{
    public static async Answer(mapper: ProblemMapper, err: unknown): Promise<{ Status: number, Body: Record<string, unknown> }>
    {
        const http = await TestHttp.Start((_req, res) => mapper.Write(res, err))
        const answer = await http.Send('/')
        await http.Close()
        return { Status: answer.Status, Body: answer.Json() }
    }
}

test('a registered error class answers its status with its message', async () =>
{
    const mapper = new ProblemMapper(() => undefined).Register(NotThereError, 404)
    const answer = await Probe.Answer(mapper, new NotThereError('no such hive'))
    assert.equal(answer.Status, 404)
    assert.deepEqual(answer.Body, { error: 'no such hive' })
})

test('a registered body adds fields (a code the UI switches on)', async () =>
{
    const mapper = new ProblemMapper(() => undefined).Register(DetailedError, 409, err => ({ code: (err as DetailedError).Code }))
    const answer = await Probe.Answer(mapper, new DetailedError('cannot'))
    assert.equal(answer.Status, 409)
    assert.deepEqual(answer.Body, { error: 'cannot', code: 'detail-code' })
})

test('an unmapped error is a generic 500 that leaks nothing, and is logged', async () =>
{
    const logged: unknown[] = []
    const mapper = new ProblemMapper(err => logged.push(err))
    const answer = await Probe.Answer(mapper, new SecretFailure('db password is hunter2'))
    assert.equal(answer.Status, 500)
    assert.deepEqual(answer.Body, { error: 'Operation failed' })
    assert.equal(logged.length, 1)
})

test('a mapped 5xx is masked unless registered unmasked; 503 is never masked', async () =>
{
    const masked = await Probe.Answer(new ProblemMapper(() => undefined).Register(UpstreamError, 502), new UpstreamError('upstream said x'))
    assert.deepEqual([masked.Status, masked.Body], [500, { error: 'Operation failed' }])
    const unmasked = await Probe.Answer(new ProblemMapper(() => undefined).RegisterUnmasked(UpstreamError, 502), new UpstreamError('the registry is unreachable'))
    assert.deepEqual([unmasked.Status, unmasked.Body], [502, { error: 'the registry is unreachable' }])
    const unavailable = await Probe.Answer(new ProblemMapper(() => undefined).Register(UpstreamError, 503), new UpstreamError('busy'))
    assert.deepEqual([unavailable.Status, unavailable.Body], [503, { error: 'busy' }])
})

test('built in: BodyTooLargeError is 413, an HttpProblem carries its own status, a non-Error is 500', async () =>
{
    const mapper = new ProblemMapper(() => undefined)
    const tooLarge = await Probe.Answer(mapper, new BodyTooLargeError())
    assert.deepEqual([tooLarge.Status, tooLarge.Body], [413, { error: 'Request body too large' }])
    const problem = await Probe.Answer(mapper, new HttpProblem(422, 'name is required'))
    assert.deepEqual([problem.Status, problem.Body], [422, { error: 'name is required' }])
    const coded = await Probe.Answer(mapper, new HttpProblem(409, 'taken', 'tenant-taken'))
    assert.deepEqual([coded.Status, coded.Body], [409, { error: 'taken', code: 'tenant-taken' }])
    const bad = await Probe.Answer(mapper, new BadRequestProblem('Name is required'))
    assert.deepEqual([bad.Status, bad.Body], [400, { error: 'Name is required', code: 'invalid-request' }])
    assert.equal((await Probe.Answer(mapper, 'a string')).Status, 500)
})

test('a subclass of a registered class maps through its parent', async () =>
{
    class DeeperNotThere extends NotThereError
    {
    }
    const answer = await Probe.Answer(new ProblemMapper(() => undefined).Register(NotThereError, 404), new DeeperNotThere('gone'))
    assert.equal(answer.Status, 404)
})

test('after headers were sent the response is only ended', async () =>
{
    const mapper = new ProblemMapper(() => undefined)
    const http = await TestHttp.Start((_req, res) =>
    {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('partial')
        mapper.Write(res, new Error('late'))
    })
    const answer = await http.Send('/')
    assert.equal(answer.Status, 200)
    assert.equal(answer.Body, 'partial')
    await http.Close()
})
