/** One throttle key's state: how many hits in the window that started at WindowStart, until when it is locked (0 when
 *  not), and when the whole state stops mattering (window over and lock over), so a store may drop it. Times in ms. */
export class ThrottleState
{
    public constructor(public readonly Count: number, public readonly WindowStart: number, public readonly LockedUntil: number, public readonly ExpiresAt: number)
    {
    }

    public IsLocked(now: number): boolean
    {
        return this.LockedUntil > now
    }

    public IsExpired(now: number): boolean
    {
        return this.ExpiresAt <= now
    }
}

/** A throttle's answer: allowed, or refused until RetryAfterMs from now. */
export class ThrottleDecision
{
    private static readonly MsPerSecond = 1000
    private static readonly NoWait = 0
    public static readonly Allow = new ThrottleDecision(true, ThrottleDecision.NoWait)

    public constructor(public readonly Allowed: boolean, public readonly RetryAfterMs: number)
    {
    }

    public static Refuse(retryAfterMs: number): ThrottleDecision
    {
        return new ThrottleDecision(false, retryAfterMs)
    }

    /** The Retry-After header value: whole seconds, rounded up. */
    public RetryAfterSeconds(): number
    {
        return Math.ceil(this.RetryAfterMs / ThrottleDecision.MsPerSecond)
    }
}
