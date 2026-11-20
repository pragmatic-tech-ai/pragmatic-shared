import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { HttpMethod } from '../../http/http-method.js'
import { HttpProblem } from '../../http/http-problem.js'
import { RouteAuth } from '../../routing/route.js'
import { ClaimsAuthorizer } from '../../authz/claims-authorizer.js'
import { AuditEntry } from '../../audit/audit-entry.js'
import { RateLimiter } from '../../limits/rate-limiter.js'
import { InMemoryThrottleRepository } from '../../limits/throttle-repository.js'
import { ProblemMapper } from '../../http/problem-mapper.js'
import { TestHttp } from '../../tests/support/test-http.js'

class NoSuchHive extends Error
{
}

class Routes
{
    public static Declare(fixture: HostFixture, calls: string[]): void
    {
        fixture.Routes
            .Add({ Method: HttpMethod.Get, Pattern: '/api/ping', Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(200, { ok: true }) })
            .Add({ Method: HttpMethod.Get, Pattern: '/api/hives', Auth: RouteAuth.Session, Handler: async ctx => ctx.WriteJson(200, { who: ctx.RequireSession().Subject }) })
            .Add({ Method: HttpMethod.Post, Pattern: '/api/hives', Auth: RouteAuth.Session, Role: 'hives.write', BodyLimit: 64, Handler: async ctx =>
            {
                calls.push('create')
                const body = await ctx.ReadJsonObject()
                ctx.NoteAudit('created ' + String(body.name))
                ctx.WriteJson(201, { name: body.name })
            } })
            .Add({ Method: HttpMethod.Delete, Pattern: '/api/hives/:id', Auth: RouteAuth.Session, Role: 'hives.write', Handler: async ctx =>
            {
                calls.push('delete ' + ctx.Param('id'))
                if (ctx.Param('id') === 'boom')
                {
                    throw new Error('secret failure detail')
                }
                if (ctx.Param('id') === 'missing')
                {
                    throw new NoSuchHive('No such hive')
                }
                if (ctx.Param('id') === 'gone')
                {
                    throw new HttpProblem(410, 'Gone')
                }
                ctx.WriteJson(204, null)
            } })
            .Add({ Method: HttpMethod.Post, Pattern: '/api/unguarded', Auth: RouteAuth.Session, Handler: async ctx =>
            {
                calls.push('unguarded')
                ctx.WriteJson(200, {})
            } })
            .Add({ Method: HttpMethod.Post, Pattern: '/api/own', Auth: RouteAuth.Session, Role: ClaimsAuthorizer.AnySignedIn, Handler: async ctx => ctx.WriteJson(200, { me: ctx.RequireSession().Subject }) })
    }
}

describe('AppHost pipeline', () =>
{
    let fixture: HostFixture
    let calls: string[]

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        calls = []
        Routes.Declare(fixture, calls)
        const problems = new ProblemMapper(() => undefined).Register(NoSuchHive, 404)
        await fixture.Start({ AllowedHosts: ['console.example'] }, { Problems: problems }, true)
    })

    afterEach(async () => await fixture.Stop())

    it('answers /healthz first: any Host, no session, before the Host guard and the bundle', async () =>
    {
        const answer = await TestHttp.Send(fixture.Port, '/healthz', { Headers: { host: 'attacker.example' } })
        assert.equal(answer.Status, 200)
        assert.equal(answer.Body, 'ok')
        const ready = await TestHttp.Send(fixture.Port, '/readyz', { Headers: { host: 'attacker.example' } })
        assert.equal(ready.Status, 200)
        fixture.Host!.SetReady(false)
        assert.equal((await TestHttp.Send(fixture.Port, '/readyz')).Status, 503)
    })

    it('refuses a Host outside the allow-list even for a GET, with or without a port; accepts configured and loopback hosts', async () =>
    {
        for (const host of ['attacker.example', 'attacker.example:80'])
        {
            const answer = await TestHttp.Send(fixture.Port, '/api/ping', { Headers: { host } })
            assert.equal(answer.Status, 403, host)
        }
        assert.equal((await TestHttp.Send(fixture.Port, '/api/ping', { Headers: { host: 'Console.Example' } })).Status, 200)
        assert.equal((await fixture.Send('/api/ping')).Status, 200)
    })

    it('puts the security headers on every response: API, bundle, refusals', async () =>
    {
        for (const answer of [await fixture.Send('/api/ping'), await fixture.Send('/'), await TestHttp.Send(fixture.Port, '/', { Headers: { host: 'evil' } })])
        {
            assert.ok((answer.Header('content-security-policy') ?? '').includes("frame-ancestors 'none'"))
            assert.equal(answer.Header('x-content-type-options'), 'nosniff')
            assert.equal(answer.Header('referrer-policy'), 'no-referrer')
        }
    })

    it('refuses a non-JSON body with 415 before anything else runs', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        const answer = await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Body: 'name=x', Headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '6' } })
        assert.equal(answer.Status, 415)
        assert.deepEqual(calls, [])
    })

    it('refuses a mutation from a foreign Origin with 403, audited as anonymous; a missing Origin is allowed', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        const foreign = await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Origin: 'http://evil.example', Json: { name: 'h' } })
        assert.equal(foreign.Status, 403)
        assert.deepEqual(calls, [])
        const [entry] = await fixture.AuditRepository.Recent(1)
        assert.deepEqual([entry?.Actor, entry?.Action, entry?.Target, entry?.Status], [AuditEntry.AnonymousActor, 'POST', '/api/hives', 403])
        assert.equal((await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Origin: null, Json: { name: 'h' } })).Status, 201)
    })

    it('answers 401 without a session; an unauthenticated mutation is audited as anonymous, a read is not', async () =>
    {
        assert.equal((await fixture.Send('/api/hives')).Status, 401)
        assert.equal((await fixture.AuditRepository.Recent(5)).length, 0)
        assert.equal((await fixture.Send('/api/hives', { Method: 'POST', Json: { name: 'h' } })).Status, 401)
        const [entry] = await fixture.AuditRepository.Recent(1)
        assert.deepEqual([entry?.Actor, entry?.Status], [AuditEntry.AnonymousActor, 401])
    })

    it('rate-limits pre-auth denials per client address with 429 and Retry-After', async () =>
    {
        await fixture.Stop()
        fixture = new HostFixture()
        Routes.Declare(fixture, calls)
        const limiter = new RateLimiter(new InMemoryThrottleRepository(), { Name: 'denials', MaxHits: 2, WindowMs: 60_000, LockoutMs: 60_000 })
        await fixture.Start({}, { DenialLimiter: limiter })
        const statuses = []
        for (let i = 0; i < 4; i++)
        {
            statuses.push((await fixture.Send('/api/hives', { Method: 'POST', Json: { name: 'h' } })).Status)
        }
        assert.deepEqual(statuses, [401, 401, 429, 429])
        const locked = await fixture.Send('/api/hives', { Method: 'POST', Origin: 'http://evil.example', Json: {} })
        assert.equal(locked.Status, 429)
        assert.match(locked.Header('retry-after') ?? '', /^\d+$/)
        assert.equal((await fixture.AuditRepository.Recent(10)).length, 2)
    })

    it('answers 403 to a session without the route role, audited with the actor', async () =>
    {
        const cookie = await fixture.SignIn('reader', ['hives.read'], { email: 'reader@x' })
        assert.equal((await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Json: { name: 'h' } })).Status, 403)
        assert.deepEqual(calls, [])
        const [entry] = await fixture.AuditRepository.Recent(1)
        assert.deepEqual([entry?.Actor, entry?.Status], ['reader@x', 403])
    })

    it('denies a Session mutation that names no role (deny by default); AnySignedIn opens one explicitly', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        assert.equal((await fixture.Send('/api/unguarded', { Method: 'POST', Cookie: cookie, Json: {} })).Status, 403)
        assert.deepEqual(calls, [])
        assert.equal((await fixture.Send('/api/own', { Method: 'POST', Cookie: cookie, Json: {} })).Status, 200)
    })

    it('a read with a session reaches its handler with the session', async () =>
    {
        const cookie = await fixture.SignIn('op', [])
        const answer = await fixture.Send('/api/hives', { Cookie: cookie })
        assert.deepEqual([answer.Status, answer.Json()], [200, { who: 'op' }])
    })

    it('audits an authorized mutation once with its final status and note; the actor is the email claim, else the subject', async () =>
    {
        const withEmail = await fixture.SignIn('op-1', ['hives.write'], { email: 'op@x' })
        assert.equal((await fixture.Send('/api/hives', { Method: 'POST', Cookie: withEmail, Json: { name: 'h1' } })).Status, 201)
        const withoutEmail = await fixture.SignIn('op-2', ['hives.write'])
        assert.equal((await fixture.Send('/api/hives/h1', { Method: 'DELETE', Cookie: withoutEmail })).Status, 204)
        const entries = await fixture.AuditRepository.Recent(5)
        assert.equal(entries.length, 2)
        const created = entries.find(e => e.Action === 'POST')
        assert.deepEqual([created?.Actor, created?.Target, created?.Status, created?.Note], ['op@x', '/api/hives', 201, 'created h1'])
        const deleted = entries.find(e => e.Action === 'DELETE')
        assert.deepEqual([deleted?.Actor, deleted?.Target, deleted?.Status], ['op-2', '/api/hives/h1', 204])
    })

    it('maps a thrown error through the ProblemMapper; a generic 500 leaks nothing; the audit carries the final status', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        const boom = await fixture.Send('/api/hives/boom', { Method: 'DELETE', Cookie: cookie })
        assert.deepEqual([boom.Status, boom.Json()], [500, { error: 'Operation failed' }])
        assert.equal((await fixture.Send('/api/hives/missing', { Method: 'DELETE', Cookie: cookie })).Status, 404)
        assert.equal((await fixture.Send('/api/hives/gone', { Method: 'DELETE', Cookie: cookie })).Status, 410)
        const statuses = (await fixture.AuditRepository.Recent(5)).map(e => e.Status).sort()
        assert.deepEqual(statuses, [404, 410, 500])
    })

    it('a declared body over the route limit is drained and answered 413 before the handler runs', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        const answer = await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Json: { name: 'x'.repeat(500) } })
        assert.equal(answer.Status, 413)
        assert.deepEqual(calls, [])
    })

    it('a chunked body over the limit reaches the caller as a 413 (drained while reading)', async () =>
    {
        const cookie = await fixture.SignIn('op', ['hives.write'])
        const answer = await fixture.Send('/api/hives', { Method: 'POST', Cookie: cookie, Body: JSON.stringify({ name: 'y'.repeat(4096) }), Headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })
        assert.equal(answer.Status, 413)
    })

    it('an unknown API path is a JSON 404; a known path under another method is 405 with Allow', async () =>
    {
        const unknown = await fixture.Send('/api/nothing')
        assert.deepEqual([unknown.Status, unknown.Json()], [404, { error: 'Not found' }])
        const wrong = await fixture.Send('/api/hives/h1', { Method: 'PUT', Json: {} })
        assert.equal(wrong.Status, 405)
        assert.equal(wrong.Header('allow'), 'DELETE')
    })

    it('serves the bundle outside the API prefix, with the SPA fallback', async () =>
    {
        const index = await fixture.Send('/')
        assert.equal(index.Status, 200)
        assert.match(index.Body, /Console/)
        assert.match((await fixture.Send('/hives/h1')).Body, /Console/)
        assert.equal((await fixture.Send('/app-ABCDEFGH.js')).Header('cache-control'), 'public, max-age=31536000, immutable')
    })
})

describe('AppHost lifecycle', () =>
{
    it('Close awaits audit writes still running after their response', async () =>
    {
        const fixture = new HostFixture()
        let release: () => void = () => undefined
        const held = new Promise<void>(resolve =>
        {
            release = resolve
        })
        const inner = fixture.AuditRepository
        const slow = { Append: async (entry: AuditEntry) =>
        {
            await held
            await inner.Append(entry)
        }, Recent: (limit: number) => inner.Recent(limit) }
        const { AuditTrail } = await import('../../audit/audit-trail.js')
        fixture.Routes.Add({ Method: HttpMethod.Post, Pattern: '/api/x', Auth: RouteAuth.Session, Role: 'w', Handler: async ctx => ctx.WriteJson(200, {}) })
        await fixture.Start({}, { Audit: new AuditTrail(slow, { Log: () => undefined }) })
        const cookie = await fixture.SignIn('op', ['w'])
        assert.equal((await fixture.Send('/api/x', { Method: 'POST', Cookie: cookie, Json: {} })).Status, 200)
        let closed = false
        const closing = fixture.Stop().then(() =>
        {
            closed = true
        })
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(closed, false)
        release()
        await closing
        assert.equal((await inner.Recent(1)).length, 1)
    })

    it('Address throws before Listen', async () =>
    {
        const { AppHost } = await import('../app-host.js')
        const { AppHostConfig } = await import('../app-host-config.js')
        const { RouteTable } = await import('../../routing/route-table.js')
        assert.throws(() => new AppHost(new AppHostConfig(), { Routes: new RouteTable() }).Address())
    })

    it('an API rate limit, when configured, answers 429 per client address', async () =>
    {
        const fixture = new HostFixture()
        fixture.Routes.Add({ Method: HttpMethod.Get, Pattern: '/api/ping', Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(200, {}) })
        await fixture.Start({}, { ApiLimiter: new RateLimiter(new InMemoryThrottleRepository(), { Name: 'api', MaxHits: 2, WindowMs: 60_000, LockoutMs: 1000 }) })
        const statuses = []
        for (let i = 0; i < 3; i++)
        {
            statuses.push((await fixture.Send('/api/ping')).Status)
        }
        assert.deepEqual(statuses, [200, 200, 429])
        await fixture.Stop()
    })
})
