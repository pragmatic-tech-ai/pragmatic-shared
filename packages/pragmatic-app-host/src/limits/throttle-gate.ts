import type { IThrottleRepository } from './throttle-repository.js'
import type { LockoutPolicy } from './lockout-policy.js'
import type { ThrottleDecision } from './throttle-state.js'

/** The atomic check-and-count both throttles share. */
export class ThrottleGate
{
    public static async Pass(repository: IThrottleRepository, policy: LockoutPolicy, key: string, now: () => number): Promise<ThrottleDecision>
    {
        let decision: ThrottleDecision | undefined
        await repository.Update(key, prior =>
        {
            const at = now()
            decision = policy.Decide(prior, at)
            return policy.Next(prior, at)
        })
        return decision as ThrottleDecision
    }
}
