import { ThrottleState } from './throttle-state.js'

/** Where throttle state lives. Update applies `change` to the key's current state atomically (no other Update of the
 *  key runs in between, across every replica sharing the store) and stores and returns its result. An expired state
 *  reads as absent. */
export interface IThrottleRepository
{
    Get(key: string): Promise<ThrottleState | undefined>
    Update(key: string, change: (prior: ThrottleState | undefined) => ThrottleState): Promise<ThrottleState>
    Delete(key: string): Promise<void>
}

/**
 * Process-local throttle state with bounded memory: expired entries are pruned on access (a full scan only once the
 * earliest tracked expiry has passed, and at most once per MinPruneIntervalMs) and past MaxKeys the oldest entry is evicted, an unlocked one first, a locked one only when none is
 * unlocked, never the key just written (so spraying keys cannot shed the caller's own lock). Update is synchronous
 * under its promise, so concurrent callers in one process serialise.
 */
export class InMemoryThrottleRepository implements IThrottleRepository
{
    private static readonly DefaultMaxKeys = 10_000
    private static readonly MinKeys = 1
    private static readonly MinPruneIntervalMs = 1000
    private static readonly NeverPruned = Number.NEGATIVE_INFINITY

    private readonly maxKeys: number
    // Map keeps insertion order; entries are re-inserted on update, so the first key is the oldest.
    private readonly entries = new Map<string, ThrottleState>()
    private lastPruneAt = InMemoryThrottleRepository.NeverPruned
    private earliestExpiry = Number.POSITIVE_INFINITY

    public constructor(maxKeys: number = InMemoryThrottleRepository.DefaultMaxKeys, private readonly now: () => number = Date.now)
    {
        this.maxKeys = Math.max(InMemoryThrottleRepository.MinKeys, maxKeys)
    }

    public async Get(key: string): Promise<ThrottleState | undefined>
    {
        const now = this.now()
        this.Prune(now)
        const state = this.entries.get(key)
        return state === undefined || state.IsExpired(now) ? undefined : state
    }

    public async Update(key: string, change: (prior: ThrottleState | undefined) => ThrottleState): Promise<ThrottleState>
    {
        const now = this.now()
        this.Prune(now)
        const prior = this.entries.get(key)
        const next = change(prior === undefined || prior.IsExpired(now) ? undefined : prior)
        this.entries.delete(key)
        this.entries.set(key, next)
        this.earliestExpiry = Math.min(this.earliestExpiry, next.ExpiresAt)
        while (this.entries.size > this.maxKeys && this.EvictOne(now, key))
        {
        }
        return next
    }

    public async Delete(key: string): Promise<void>
    {
        this.entries.delete(key)
    }

    /** Number of tracked keys (observability, tests). */
    public Size(): number
    {
        return this.entries.size
    }

    /** Evicts the oldest unlocked entry, else the oldest locked one, never `keep`; false when there is no victim. */
    private EvictOne(now: number, keep: string): boolean
    {
        let fallback: string | undefined
        for (const [key, state] of this.entries)
        {
            if (key === keep)
            {
                continue
            }
            if (!state.IsLocked(now))
            {
                this.entries.delete(key)
                return true
            }
            fallback ??= key
        }
        if (fallback === undefined)
        {
            return false
        }
        this.entries.delete(fallback)
        return true
    }

    private Prune(now: number): void
    {
        if (now < this.earliestExpiry || now - this.lastPruneAt < InMemoryThrottleRepository.MinPruneIntervalMs)
        {
            return
        }
        this.lastPruneAt = now
        this.earliestExpiry = Number.POSITIVE_INFINITY
        for (const [key, state] of this.entries)
        {
            if (state.IsExpired(now))
            {
                this.entries.delete(key)
                continue
            }
            this.earliestExpiry = Math.min(this.earliestExpiry, state.ExpiresAt)
        }
    }
}
