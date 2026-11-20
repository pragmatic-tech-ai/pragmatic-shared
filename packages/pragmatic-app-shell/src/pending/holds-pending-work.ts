/**
 * A page holding work the person has started but not submitted (a half-filled form). Its section never discards it
 * to show a page opened from another section: the cross-section open lands on the pending work instead. Unlike a
 * pending one-time value it does not block the page's own Back or Cancel: the person may still leave it on purpose.
 * The page raises `PendingWork.ChangedProperty` whenever HasPendingWork flips.
 */
export interface IHoldsPendingWork
{
    readonly HasPendingWork: boolean
}

/**
 * Recognises a page holding pending work. Holding pages register themselves (Register) in their constructor, so
 * recognition is by identity, not by a member-name probe.
 */
export class PendingWork
{
    public static readonly ChangedProperty = 'HasPendingWork'

    private static readonly holders = new WeakSet<object>()

    public static Register(page: IHoldsPendingWork): void
    {
        PendingWork.holders.add(page)
    }

    public static IsHolder(page: object | undefined): page is IHoldsPendingWork
    {
        return page !== undefined && PendingWork.holders.has(page)
    }

    public static IsHeldBy(page: object | undefined): boolean
    {
        return PendingWork.IsHolder(page) && page.HasPendingWork
    }
}
