import { ThrottleDecision, ThrottleState } from './throttle-state.js'

/**
 * Fixed-window counting with a fixed lockout: a key locks for LockoutMs once its count inside one window reaches
 * LockAt. A hit after the window restarts the count. A hit on a locked key is refused and changes nothing (it does
 * not extend the lock).
 */
export class LockoutPolicy
{
    private static readonly FirstHit = 1
    private static readonly NoLock = 0

    public constructor(public readonly LockAt: number, public readonly WindowMs: number, public readonly LockoutMs: number)
    {
    }

    public Decide(state: ThrottleState | undefined, now: number): ThrottleDecision
    {
        return state !== undefined && state.IsLocked(now) ? ThrottleDecision.Refuse(state.LockedUntil - now) : ThrottleDecision.Allow
    }

    /** The state after one more hit at `now` (the prior state unchanged when it is locked). */
    public Next(prior: ThrottleState | undefined, now: number): ThrottleState
    {
        if (prior !== undefined && prior.IsLocked(now))
        {
            return prior
        }
        const fresh = prior === undefined || now - prior.WindowStart >= this.WindowMs
        const count = fresh ? LockoutPolicy.FirstHit : prior.Count + 1
        const windowStart = fresh ? now : prior.WindowStart
        const lockedUntil = count >= this.LockAt ? now + this.LockoutMs : LockoutPolicy.NoLock
        return new ThrottleState(count, windowStart, lockedUntil, Math.max(windowStart + this.WindowMs, lockedUntil))
    }
}
