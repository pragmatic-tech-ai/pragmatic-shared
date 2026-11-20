import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { PasswordLoginEndpoint } from '../password-login-endpoint.js'
import type { IPasswordAuthenticator } from '../password-authenticator.js'
import { SignedInIdentity } from '../../session/signed-in-identity.js'
import { SessionClaims } from '../../session/session-claims.js'
import { SessionEndpoint } from '../../endpoints/session-endpoint.js'
import { LoginThrottle } from '../../limits/login-throttle.js'
import { InMemoryThrottleRepository } from '../../limits/throttle-repository.js'

class Operators implements IPasswordAuthenticator
{
    public Calls = 0

    public async Authenticate(account: string, password: string): Promise<SignedInIdentity | null>
    {
        this.Calls++
        return account === 'op@example.com' && password === 'right horse' ? new SignedInIdentity('op-1', SessionClaims.From({ email: account, roles: ['platform.full'] })) : null
    }
}

describe('PasswordLoginEndpoint', () =>
{
    let fixture: HostFixture
    let operators: Operators

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        operators = new Operators()
        const throttle = new LoginThrottle(new InMemoryThrottleRepository(), { MaxAttempts: 3 })
        new PasswordLoginEndpoint(operators, fixture.Gate, throttle).Register(fixture.Routes)
        new SessionEndpoint(fixture.Gate).Register(fixture.Routes)
        await fixture.Start({}, {})
    })

    afterEach(async () => await fixture.Stop())

    it('a right password issues the session cookie; the session carries the authenticator\'s claims', async () =>
    {
        const answer = await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'right horse' } })
        assert.equal(answer.Status, 200)
        assert.deepEqual(answer.Json(), { subject: 'op-1' })
        const cookie = (answer.Header('set-cookie') ?? '').split(';')[0] as string
        assert.match(cookie, /^app_session=[A-Za-z0-9_-]+$/)
        const session = await fixture.Send('/api/session', { Cookie: cookie })
        assert.deepEqual(session.Json(), { subject: 'op-1', claims: { email: ['op@example.com'], roles: ['platform.full'] } })
    })

    it('a wrong password is a generic 401 with no cookie and nothing of the password', async () =>
    {
        const answer = await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })
        assert.equal(answer.Status, 401)
        assert.equal(answer.Header('set-cookie'), undefined)
        assert.ok(!answer.Body.includes('wrong'))
    })

    it('a malformed body is 400', async () =>
    {
        assert.equal((await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com' } })).Status, 400)
        assert.equal((await fixture.Send('/api/login', { Method: 'POST', Json: ['x'] })).Status, 400)
    })

    it('answers 429 with a numeric Retry-After and never calls Authenticate once locked', async () =>
    {
        for (let i = 0; i < 3; i++)
        {
            await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })
        }
        const locked = await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'right horse' } })
        assert.equal(locked.Status, 429)
        assert.match(locked.Header('retry-after') ?? '', /^\d+$/)
        assert.equal(operators.Calls, 3)
    })

    it('lets only MaxAttempts of a parallel burst reach Authenticate', async () =>
    {
        await Promise.all(Array.from({ length: 8 }, () => fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })))
        assert.equal(operators.Calls, 3)
    })

    it('a success clears the optimistic count', async () =>
    {
        await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })
        await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })
        assert.equal((await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'right horse' } })).Status, 200)
        for (let i = 0; i < 2; i++)
        {
            await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'wrong' } })
        }
        assert.equal((await fixture.Send('/api/login', { Method: 'POST', Json: { email: 'op@example.com', password: 'right horse' } })).Status, 200)
    })
})
