import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { HostFixture } from '../../tests/support/host-fixture.js'
import type { TestResponse } from '../../tests/support/test-http.js'
import { RouteAuth, RouteBody } from '../../routing/route.js'
import { HttpMethod } from '../../http/http-method.js'
import { AppHostConfig } from '../app-host-config.js'
import { AppHost } from '../app-host.js'
import { RouteTable } from '../../routing/route-table.js'

/** A host with two form routes (one with a tiny body limit) and a JSON route. */
class FormHost
{
    public static readonly FormType = 'application/x-www-form-urlencoded; charset=utf-8'
    public readonly Fixture = new HostFixture()

    public async Start(): Promise<this>
    {
        this.Fixture.Routes.Add({
            Method: HttpMethod.Post, Pattern: '/oauth/token', Auth: RouteAuth.Public, Body: RouteBody.Form,
            Handler: async ctx =>
            {
                const form = await ctx.ReadForm()
                ctx.WriteJson(200, { grant: form.get('grant_type'), code: form.get('code') })
            },
        })
        this.Fixture.Routes.Add({ Method: HttpMethod.Post, Pattern: '/api/json', Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(200, await ctx.ReadJsonObject()) })
        this.Fixture.Routes.Add({ Method: HttpMethod.Post, Pattern: '/oauth/small', Auth: RouteAuth.Public, Body: RouteBody.Form, BodyLimit: 8, Handler: async ctx => ctx.WriteJson(200, { size: [...await ctx.ReadForm()].length }) })
        await this.Fixture.Start()
        return this
    }

    /** A form POST from a non-browser client (no Origin), as an OAuth relying party sends it. */
    public Form(path: string, body: string): Promise<TestResponse>
    {
        return this.Fixture.Send(path, { Method: 'POST', Origin: null, Headers: { 'content-type': FormHost.FormType, 'content-length': String(Buffer.byteLength(body)) }, Body: body })
    }
}

/** The test-only self-signed localhost certificate (never used outside these tests) and one https exchange trusting it. */
class TestTls
{
    private static readonly Folder = join(import.meta.dirname, 'fixtures')
    public static readonly Key = readFileSync(join(TestTls.Folder, 'localhost-test.key.pem'))
    public static readonly Cert = readFileSync(join(TestTls.Folder, 'localhost-test.cert.pem'))

    public static Send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: '127.0.0.1', port, path, method, ca: TestTls.Cert, servername: 'localhost', headers: { host: 'localhost:' + port, ...headers } }, res =>
            {
                res.resume()
                res.on('end', () => resolve(res.statusCode ?? 0))
            })
            req.on('error', reject)
            req.end()
        })
    }
}

describe('AppHost form-bodied routes', () =>
{
    let host: FormHost

    afterEach(async () => await host.Fixture.Stop())

    it('a route declaring a form body answers a form POST, decoded; a JSON route and an unknown path still refuse it 415', async () =>
    {
        host = await new FormHost().Start()
        const token = await host.Form('/oauth/token', 'grant_type=authorization_code&code=a%2Bb')
        assert.equal(token.Status, 200)
        assert.deepEqual(token.Json(), { grant: 'authorization_code', code: 'a+b' })
        assert.equal((await host.Form('/api/json', 'a=1')).Status, 415)
        assert.equal((await host.Form('/api/unknown', 'a=1')).Status, 415)
    })

    it('a form route refuses a JSON body 415 and a form larger than its limit 413', async () =>
    {
        host = await new FormHost().Start()
        assert.equal((await host.Fixture.Send('/oauth/token', { Method: 'POST', Origin: null, Json: { grant_type: 'x' } })).Status, 415)
        assert.equal((await host.Form('/oauth/small', 'a=1&b=22222222')).Status, 413)
        assert.equal((await host.Form('/oauth/small', 'a=1')).Status, 200)
    })
})

describe('AppHost over TLS', () =>
{
    let host: AppHost | undefined

    afterEach(async () => await host?.Close())

    it('an AppHost with Tls answers /healthz over https, and its Origin guard takes the own origin as https', async () =>
    {
        const routes = new RouteTable()
        routes.Add({ Method: HttpMethod.Post, Pattern: '/api/ping', Auth: RouteAuth.Public, Handler: async ctx => ctx.WriteJson(200, { ok: true }) })
        host = new AppHost(new AppHostConfig({ Tls: { Key: TestTls.Key, Cert: TestTls.Cert } }), { Routes: routes })
        await host.Listen(0, '127.0.0.1')
        const port = host.Address().port
        assert.equal(await TestTls.Send(port, 'GET', '/healthz'), 200)
        assert.equal(await TestTls.Send(port, 'POST', '/api/ping', { origin: 'https://localhost:' + port }), 200)
        assert.equal(await TestTls.Send(port, 'POST', '/api/ping', { origin: 'http://localhost:' + port }), 403)
    })

    it('without Tls the host serves plain HTTP (Tls stays undefined)', () =>
    {
        assert.equal(new AppHostConfig().Tls, undefined)
        assert.equal(new AppHostConfig({ Tls: { Key: TestTls.Key, Cert: TestTls.Cert } }).Tls?.Cert, TestTls.Cert)
    })
})
