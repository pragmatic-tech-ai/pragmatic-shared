import type { IThrottleRepository } from './throttle-repository.js'
import { LockoutPolicy } from './lockout-policy.js'
import { ThrottleGate } from './throttle-gate.js'
import type { ThrottleDecision } from './throttle-state.js'

export interface LoginThrottleOptions
{
    MaxAttempts?: number
    WindowMs?: number
    LockoutMs?: number
    /** Namespaces the keys when several throttles share one repository. */
    Name?: string
    Now?: () => number
}

/**
 * Sign-in throttle keyed by (normalized account, client address): MaxAttempts attempts inside one window lock the key
 * for LockoutMs. Attempt counts at the gate, before the credential is checked (optimistically, in one atomic step, so a
 * parallel burst lets only MaxAttempts through); Succeeded wipes the count.
 */
export class LoginThrottle
{
    private static readonly DefaultMaxAttempts = 5
    private static readonly DefaultWindowMs = 15 * 60 * 1000
    private static readonly DefaultLockoutMs = 15 * 60 * 1000
    private static readonly DefaultName = 'login'
    private static readonly KeySeparator = '\u001f'

    private readonly policy: LockoutPolicy
    private readonly prefix: string
    private readonly now: () => number

    public constructor(private readonly repository: IThrottleRepository, options: LoginThrottleOptions = {})
    {
        this.policy = new LockoutPolicy(options.MaxAttempts ?? LoginThrottle.DefaultMaxAttempts, options.WindowMs ?? LoginThrottle.DefaultWindowMs, options.LockoutMs ?? LoginThrottle.DefaultLockoutMs)
        this.prefix = (options.Name ?? LoginThrottle.DefaultName) + LoginThrottle.KeySeparator
        this.now = options.Now ?? Date.now
    }

    public async Check(account: string, address: string): Promise<ThrottleDecision>
    {
        return this.policy.Decide(await this.repository.Get(this.KeyOf(account, address)), this.now())
    }

    /** Refused when locked; otherwise counts this attempt as a failure until Succeeded says otherwise. */
    public async Attempt(account: string, address: string): Promise<ThrottleDecision>
    {
        return await ThrottleGate.Pass(this.repository, this.policy, this.KeyOf(account, address), this.now)
    }

    public async Succeeded(account: string, address: string): Promise<void>
    {
        await this.repository.Delete(this.KeyOf(account, address))
    }

    private KeyOf(account: string, address: string): string
    {
        return this.prefix + account.trim().toLowerCase() + LoginThrottle.KeySeparator + address
    }
}
