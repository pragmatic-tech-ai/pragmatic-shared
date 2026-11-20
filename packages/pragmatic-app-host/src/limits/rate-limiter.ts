import type { IThrottleRepository } from './throttle-repository.js'
import { LockoutPolicy } from './lockout-policy.js'
import type { ThrottleDecision } from './throttle-state.js'
import { ThrottleGate } from './throttle-gate.js'

export interface RateLimiterOptions
{
    /** Namespaces this limiter's keys, so several limiters can share one repository. */
    Name: string
    /** Hits allowed per window: the last of them locks the key, so the next one is refused. */
    MaxHits: number
    WindowMs: number
    LockoutMs: number
    Now?: () => number
}

/** Per-key (a client address) rate limit: MaxHits hits per window; the hit after them is refused, and every hit until
 *  LockoutMs after the last allowed one. Hit is
 *  check-and-count in one atomic step, so a parallel burst cannot slip past the gate. */
export class RateLimiter
{
    private static readonly KeySeparator = '\u001f'

    private readonly policy: LockoutPolicy
    private readonly prefix: string
    private readonly now: () => number

    public constructor(private readonly repository: IThrottleRepository, options: RateLimiterOptions)
    {
        this.policy = new LockoutPolicy(options.MaxHits, options.WindowMs, options.LockoutMs)
        this.prefix = options.Name + RateLimiter.KeySeparator
        this.now = options.Now ?? Date.now
    }

    /** Whether `key` is currently allowed (counts nothing). */
    public async Check(key: string): Promise<ThrottleDecision>
    {
        return this.policy.Decide(await this.repository.Get(this.prefix + key), this.now())
    }

    /** Refused when `key` is locked (nothing counted); otherwise counts the hit (which may lock the key) and allows it. */
    public async Hit(key: string): Promise<ThrottleDecision>
    {
        return await ThrottleGate.Pass(this.repository, this.policy, this.prefix + key, this.now)
    }
}
