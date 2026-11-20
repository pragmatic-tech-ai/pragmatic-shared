import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HealthEndpoint, HealthResult } from '../health-endpoint.js'

test('/healthz is 200 ok; /readyz follows readiness; other paths and methods are not probes', () =>
{
    const health = new HealthEndpoint()
    assert.deepEqual(health.Handle('GET', '/healthz', false), new HealthResult(200, 'ok'))
    assert.deepEqual(health.Handle('GET', '/readyz', true), new HealthResult(200, 'ok'))
    assert.deepEqual(health.Handle('GET', '/readyz', false), new HealthResult(503, 'not ready'))
    assert.equal(health.Handle('POST', '/healthz', true), null)
    assert.equal(health.Handle('GET', '/api/x', true), null)
})
