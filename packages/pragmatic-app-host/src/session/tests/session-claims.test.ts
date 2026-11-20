import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionClaims } from '../session-claims.js'

test('From takes single values and lists; Values, First and Has read them', () =>
{
    const claims = SessionClaims.From({ email: 'a@x', roles: ['tenant.admin', 'app.reader'] })
    assert.deepEqual(claims.Values('roles'), ['tenant.admin', 'app.reader'])
    assert.equal(claims.First('email'), 'a@x')
    assert.equal(claims.Has('roles', 'app.reader'), true)
    assert.equal(claims.Has('roles', 'app.writer'), false)
    assert.deepEqual(claims.Values('missing'), [])
    assert.equal(claims.First('missing'), undefined)
})

test('ToJson / FromJson round-trip; FromJson drops non-string values', () =>
{
    const claims = SessionClaims.From({ tenant: 'acme', roles: ['a', 'b'] })
    assert.deepEqual(SessionClaims.FromJson(JSON.stringify(claims.ToJson())), claims)
    assert.deepEqual(SessionClaims.FromJson('{"a":[1,"x"],"b":3,"c":"y"}').ToJson(), { a: ['x'], c: ['y'] })
    assert.deepEqual(SessionClaims.FromJson('not json').ToJson(), {})
})

test('With returns a copy with one claim replaced; the original is unchanged', () =>
{
    const claims = SessionClaims.From({ roles: ['a'] })
    const more = claims.With('roles', ['a', 'b'])
    assert.deepEqual(more.Values('roles'), ['a', 'b'])
    assert.deepEqual(claims.Values('roles'), ['a'])
})
