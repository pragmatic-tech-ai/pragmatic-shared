import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SecurityHeaders } from '../security-headers.js'
import { TestHttp } from '../../tests/support/test-http.js'

test('the defaults: a self-only CSP that forbids framing, nosniff, DENY framing and no referrer', async () =>
{
    const headers = new SecurityHeaders()
    const http = await TestHttp.Start((_req, res) =>
    {
        headers.Apply(res)
        res.end()
    })
    const answer = await http.Send('/')
    const csp = answer.Header('content-security-policy') ?? ''
    assert.ok(csp.includes("default-src 'self'"))
    assert.ok(csp.includes("frame-ancestors 'none'"))
    assert.ok(csp.includes("object-src 'none'"))
    assert.ok(!csp.includes('unsafe-eval'))
    assert.equal(answer.Header('x-content-type-options'), 'nosniff')
    assert.equal(answer.Header('x-frame-options'), 'DENY')
    assert.equal(answer.Header('referrer-policy'), 'no-referrer')
    await http.Close()
})

test('the CSP and Referrer-Policy are configurable', async () =>
{
    const headers = new SecurityHeaders({ ContentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'", ReferrerPolicy: 'same-origin' })
    const http = await TestHttp.Start((_req, res) =>
    {
        headers.Apply(res)
        res.end()
    })
    const answer = await http.Send('/')
    assert.equal(answer.Header('content-security-policy'), "default-src 'none'; frame-ancestors 'none'")
    assert.equal(answer.Header('referrer-policy'), 'same-origin')
    await http.Close()
})
