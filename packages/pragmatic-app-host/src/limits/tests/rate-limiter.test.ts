import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../rate-limiter.js'
import { InMemoryThrottleRepository } from '../throttle-repository.js'

class Harness
{
    public static readonly IpA = '10.0.0.1'
    public static readonly IpB = '10.0.0.2'
    public static readonly WindowMs = 1000
    public static readonly LockoutMs = 2000
    public static readonly Step = 1

    public Clock = 0

    public Make(maxKeys?: number): RateLimiter
    {
        const now = (): number => this.Clock
        return new RateLimiter(new InMemoryThrottleRepository(maxKeys, now), { Name: 'denials', MaxHits: 2, WindowMs: Harness.WindowMs, LockoutMs: Harness.LockoutMs, Now: now })
    }

    public async Hit(limiter: RateLimiter, key: string, n: number): Promise<void>
    {
        for (let i = 0; i < n; i++)
        {
            await limiter.Hit(key)
        }
    }
}

describe('RateLimiter', () =>
{
    it('allows under the threshold', async () =>
    {
        const h = new Harness()
        const limiter = h.Make()
        await h.Hit(limiter, Harness.IpA, 1)
        assert.equal((await limiter.Check(Harness.IpA)).Allowed, true)
    })

    it('allows MaxHits hits, then locks, with a positive RetryAfterMs; a locked Hit is refused', async () =>
    {
        const h = new Harness()
        const limiter = h.Make()
        await h.Hit(limiter, Harness.IpA, 2)
        const d = await limiter.Check(Harness.IpA)
        assert.equal(d.Allowed, false)
        assert.ok(d.RetryAfterMs > 0)
        assert.equal((await limiter.Hit(Harness.IpA)).Allowed, false)
    })

    it('unlocks after the lockout', async () =>
    {
        const h = new Harness()
        const limiter = h.Make()
        await h.Hit(limiter, Harness.IpA, 2)
        h.Clock += Harness.LockoutMs + Harness.Step
        assert.equal((await limiter.Check(Harness.IpA)).Allowed, true)
    })

    it('resets the window, so spread hits never lock', async () =>
    {
        const h = new Harness()
        const limiter = h.Make()
        for (let i = 0; i < 6; i++)
        {
            await limiter.Hit(Harness.IpA)
            h.Clock += Harness.WindowMs + Harness.Step
        }
        assert.equal((await limiter.Check(Harness.IpA)).Allowed, true)
    })

    it('is bounded by maxKeys', async () =>
    {
        const h = new Harness()
        const limiter = h.Make(1)
        await h.Hit(limiter, Harness.IpA, 2)
        assert.equal((await limiter.Check(Harness.IpA)).Allowed, false)
        await limiter.Hit(Harness.IpB)
        assert.equal((await limiter.Check(Harness.IpA)).Allowed, true)
    })

    it('isolates keys, and two limiters over one repository do not share buckets', async () =>
    {
        const h = new Harness()
        const now = (): number => h.Clock
        const repository = new InMemoryThrottleRepository(undefined, now)
        const first = new RateLimiter(repository, { Name: 'first', MaxHits: 1, WindowMs: Harness.WindowMs, LockoutMs: Harness.LockoutMs, Now: now })
        const second = new RateLimiter(repository, { Name: 'second', MaxHits: 1, WindowMs: Harness.WindowMs, LockoutMs: Harness.LockoutMs, Now: now })
        await h.Hit(first, Harness.IpA, 2)
        assert.equal((await first.Check(Harness.IpA)).Allowed, false)
        assert.equal((await first.Check(Harness.IpB)).Allowed, true)
        assert.equal((await second.Check(Harness.IpA)).Allowed, true)
    })

    it('RetryAfterSeconds rounds up', async () =>
    {
        const h = new Harness()
        const limiter = h.Make()
        await h.Hit(limiter, Harness.IpA, 2)
        h.Clock += 500
        assert.equal((await limiter.Check(Harness.IpA)).RetryAfterSeconds(), 2)
    })
})
