/**
 * How long a session lives: TtlMs from issue; when RenewalIntervalMs is set the expiry slides to now + TtlMs on use, at
 * most once per interval, and never past issue + MaxLifetimeMs. A session keeps the policy it was issued under.
 */
export class SessionPolicy
{
    private static readonly NoRenewal = 0

    public constructor(public readonly TtlMs: number, public readonly RenewalIntervalMs: number = SessionPolicy.NoRenewal, public readonly MaxLifetimeMs: number = TtlMs)
    {
    }

    public get Slides(): boolean
    {
        return this.RenewalIntervalMs > SessionPolicy.NoRenewal
    }

    /** The expiry a renewal at `now` gives a session issued at `issuedAt`. */
    public RenewedExpiry(issuedAt: Date, now: Date): Date
    {
        return new Date(Math.min(now.getTime() + this.TtlMs, issuedAt.getTime() + this.MaxLifetimeMs))
    }

    /** Whether a session last kept at `keptAt` is due for renewal at `now`. */
    public IsDue(keptAt: Date, now: Date): boolean
    {
        return this.Slides && now.getTime() - keptAt.getTime() >= this.RenewalIntervalMs
    }
}
