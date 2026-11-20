import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LoginThrottle } from '../login-throttle.js'
import { InMemoryThrottleRepository } from '../throttle-repository.js'

class Clock
{
    public Time = 1000
    public readonly Now = (): number => this.Time
}

class Fixture
{
    public static readonly Email = 'Op@Example.com'
    public static readonly Ip = '10.0.0.1'
    public static readonly Max = 3
    public static readonly Window = 1000
    public static readonly Lockout = 5000

    public static Make(clock: Clock, maxKeys?: number): { Throttle: LoginThrottle, Repository: InMemoryThrottleRepository }
    {
        const repository = new InMemoryThrottleRepository(maxKeys, clock.Now)
        return { Throttle: new LoginThrottle(repository, { MaxAttempts: Fixture.Max, WindowMs: Fixture.Window, LockoutMs: Fixture.Lockout, Now: clock.Now }), Repository: repository }
    }

    public static async Fail(t: LoginThrottle, n: number, email = Fixture.Email, ip = Fixture.Ip): Promise<void>
    {
        for (let i = 0; i < n; i++)
        {
            await t.Attempt(email, ip)
        }
    }
}

describe('LoginThrottle', () =>
{
    it('locks after MaxAttempts attempts and reports RetryAfterMs; the account is normalized, the address is not shared', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        await Fixture.Fail(t, Fixture.Max - 1)
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, true)
        await Fixture.Fail(t, 1)
        const d = await t.Check(Fixture.Email, Fixture.Ip)
        assert.equal(d.Allowed, false)
        assert.equal(d.RetryAfterMs, Fixture.Lockout)
        assert.equal((await t.Check(' op@example.com ', Fixture.Ip)).Allowed, false)
        assert.equal((await t.Check(Fixture.Email, '10.0.0.2')).Allowed, true)
    })

    it('Attempt counts optimistically and refuses once locked, without extending the lock', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        const decisions = []
        for (let i = 0; i < Fixture.Max + 2; i++)
        {
            decisions.push((await t.Attempt(Fixture.Email, Fixture.Ip)).Allowed)
        }
        assert.deepEqual(decisions, [true, true, true, false, false])
        clock.Time += Fixture.Lockout
        assert.equal((await t.Attempt(Fixture.Email, Fixture.Ip)).Allowed, true)
    })

    it('a parallel burst lets only MaxAttempts through', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        const burst = await Promise.all(Array.from({ length: 10 }, () => t.Attempt(Fixture.Email, Fixture.Ip)))
        assert.equal(burst.filter(d => d.Allowed).length, Fixture.Max)
    })

    it('unlocks after LockoutMs', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        await Fixture.Fail(t, Fixture.Max)
        clock.Time += Fixture.Lockout - 1
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, false)
        clock.Time += 1
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, true)
    })

    it('Succeeded resets the counter', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        await Fixture.Fail(t, Fixture.Max)
        await t.Succeeded(Fixture.Email, Fixture.Ip)
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, true)
        await Fixture.Fail(t, Fixture.Max - 1)
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, true)
    })

    it('attempts outside WindowMs do not accumulate', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock)
        await Fixture.Fail(t, Fixture.Max - 1)
        clock.Time += Fixture.Window
        await Fixture.Fail(t, Fixture.Max - 1)
        assert.equal((await t.Check(Fixture.Email, Fixture.Ip)).Allowed, true)
    })

    it('evicts the oldest key past maxKeys', async () =>
    {
        const clock = new Clock()
        const { Throttle: t } = Fixture.Make(clock, 2)
        await Fixture.Fail(t, Fixture.Max, 'a@x', Fixture.Ip)
        await Fixture.Fail(t, Fixture.Max, 'b@x', Fixture.Ip)
        await Fixture.Fail(t, Fixture.Max, 'c@x', Fixture.Ip)
        assert.equal((await t.Check('a@x', Fixture.Ip)).Allowed, true)
        assert.equal((await t.Check('b@x', Fixture.Ip)).Allowed, false)
        assert.equal((await t.Check('c@x', Fixture.Ip)).Allowed, false)
    })

    it('prunes stale entries on access', async () =>
    {
        const clock = new Clock()
        const { Throttle: t, Repository: repository } = Fixture.Make(clock, 3)
        await Fixture.Fail(t, 1, 'a@x', Fixture.Ip)
        await Fixture.Fail(t, Fixture.Max, 'b@x', Fixture.Ip)
        assert.equal(repository.Size(), 2)
        clock.Time += Fixture.Window + Fixture.Lockout
        await t.Check('z@x', Fixture.Ip)
        assert.equal(repository.Size(), 0)
    })

    it('terminates with a degenerate maxKeys cap (clamped to 1)', async () =>
    {
        const clock = new Clock()
        const { Throttle: t, Repository: repository } = Fixture.Make(clock, 0)
        await Fixture.Fail(t, Fixture.Max, 'a@x', Fixture.Ip)
        await Fixture.Fail(t, Fixture.Max, 'b@x', Fixture.Ip)
        await Fixture.Fail(t, 1, 'c@x', Fixture.Ip)
        assert.equal(repository.Size(), 1)
    })

    it('evicts unlocked entries before locked ones', async () =>
    {
        const clock = new Clock()
        const { Throttle: t, Repository: repository } = Fixture.Make(clock, 2)
        await Fixture.Fail(t, Fixture.Max, 'locked@x', Fixture.Ip)
        await Fixture.Fail(t, 1, 'u1@x', Fixture.Ip)
        await Fixture.Fail(t, 1, 'u2@x', Fixture.Ip)
        assert.equal(repository.Size(), 2)
        assert.equal((await t.Check('locked@x', Fixture.Ip)).Allowed, false)
    })
})
