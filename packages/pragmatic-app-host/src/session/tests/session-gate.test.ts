import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { SessionGate } from '../session-gate.js'
import { SessionStore } from '../session-store.js'
import { InMemorySessionRepository } from '../session-repository.js'
import { SessionCookie } from '../session-cookie.js'
import { SessionClaims } from '../session-claims.js'
import { SessionPolicy } from '../session-policy.js'

class Fixture
{
    public static Request(cookie: string | undefined): IncomingMessage
    {
        return { headers: cookie === undefined ? {} : { cookie } } as unknown as IncomingMessage
    }
}

test('Current is the session the cookie names; absent, malformed, unknown or revoked is null', async () =>
{
    const store = new SessionStore(new InMemorySessionRepository(), new SessionPolicy(60_000))
    const cookie = new SessionCookie({ Name: 'app_session', Secure: false })
    const gate = new SessionGate(store, cookie)
    const issued = await store.Issue('alice', SessionClaims.From({ roles: ['r'] }))
    assert.equal((await gate.Current(Fixture.Request('x=1; app_session=' + issued.Token)))?.Subject, 'alice')
    assert.equal(gate.Token(Fixture.Request('app_session=' + issued.Token)), issued.Token)
    assert.equal(await gate.Current(Fixture.Request(undefined)), null)
    assert.equal(await gate.Current(Fixture.Request('app_session=bad token')), null)
    assert.equal(await gate.Current(Fixture.Request('app_session=unknown')), null)
    await store.Revoke(issued.Token)
    assert.equal(await gate.Current(Fixture.Request('app_session=' + issued.Token)), null)
})
