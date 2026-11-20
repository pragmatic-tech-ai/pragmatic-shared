import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { SqlThrottleRepository } from '../sql-throttle-repository.js'
import { ThrottleState } from '../throttle-state.js'
import { LoginThrottle } from '../login-throttle.js'

class Clock
{
    public Time = 1_000_000
    public readonly Now = (): number => this.Time
}

SqlTestSessions.Describe('SqlThrottleRepository', (makeSession, backend) =>
{
    test(`${backend}: Update stores the changed state; Get reads it back; Delete removes it`, async () =>
    {
        const clock = new Clock()
        const repository = await SqlThrottleRepository.Open(await makeSession(), clock.Now)
        assert.equal(await repository.Get('k'), undefined)
        const stored = await repository.Update('k', prior =>
        {
            assert.equal(prior, undefined)
            return new ThrottleState(1, clock.Time, 0, clock.Time + 500)
        })
        assert.deepEqual(stored, new ThrottleState(1, clock.Time, 0, clock.Time + 500))
        assert.deepEqual(await repository.Get('k'), stored)
        await repository.Update('k', prior => new ThrottleState(prior!.Count + 1, prior!.WindowStart, 7, prior!.ExpiresAt))
        assert.equal((await repository.Get('k'))!.Count, 2)
        await repository.Delete('k')
        assert.equal(await repository.Get('k'), undefined)
    })

    test(`${backend}: an expired state reads as absent and is swept`, async () =>
    {
        const clock = new Clock()
        const session = await makeSession()
        const repository = await SqlThrottleRepository.Open(session, clock.Now)
        await repository.Update('old', () => new ThrottleState(3, clock.Time, clock.Time + 100, clock.Time + 100))
        clock.Time += 100
        assert.equal(await repository.Get('old'), undefined)
        await repository.Update('new', () => new ThrottleState(1, clock.Time, 0, clock.Time + 1000))
        assert.equal((await session.Query('SELECT key FROM app_host_throttles WHERE key = $1', ['old'])).length, 0)
    })

    test(`${backend}: a lock survives a restart (another repository over the same database)`, async () =>
    {
        const clock = new Clock()
        const session = await makeSession()
        const first = new LoginThrottle(await SqlThrottleRepository.Open(session, clock.Now), { MaxAttempts: 2, WindowMs: 1000, LockoutMs: 5000, Now: clock.Now })
        await first.Attempt('a@x', '1.1.1.1')
        await first.Attempt('a@x', '1.1.1.1')
        const second = new LoginThrottle(await SqlThrottleRepository.Open(session, clock.Now), { MaxAttempts: 2, WindowMs: 1000, LockoutMs: 5000, Now: clock.Now })
        assert.equal((await second.Check('a@x', '1.1.1.1')).Allowed, false)
    })
})

SqlTestSessions.DescribeLive('SqlThrottleRepository', makeDatabase =>
{
    test('SqlThrottleRepository [live]: a parallel burst across replicas lets only MaxAttempts through', async () =>
    {
        const database = await makeDatabase()
        const clock = new Clock()
        const replicas = await Promise.all(Array.from({ length: 4 }, async () => new LoginThrottle(await SqlThrottleRepository.Open(database.Session(), clock.Now), { MaxAttempts: 3, WindowMs: 60_000, LockoutMs: 60_000, Now: clock.Now })))
        const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => replicas[i % replicas.length]!.Attempt('a@x', '1.1.1.1')))
        assert.equal(burst.filter(d => d.Allowed).length, 3)
        await database.Dispose()
    })
})
