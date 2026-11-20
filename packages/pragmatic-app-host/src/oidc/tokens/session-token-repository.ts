/** One session's sealed upstream tokens (SessionTokenVault), keyed by the session id (the bearer's digest). */
export class SealedSessionTokens
{
    public constructor(public readonly SessionId: string, public readonly Sealed: string, public readonly ExpiresAt: Date)
    {
    }
}

/** Where sealed session tokens live. Put replaces the session's row (a refresh re-seals). */
export interface ISessionTokenRepository
{
    Put(row: SealedSessionTokens): Promise<void>
    Find(sessionId: string): Promise<SealedSessionTokens | undefined>
    Delete(sessionId: string): Promise<void>
    /** Drops rows whose expiry is at or before `now`; returns how many. */
    DeleteExpired(now: Date): Promise<number>
}

/** Process-local sealed tokens: for tests and single-process tools (applications use SqlSessionTokenRepository). */
export class InMemorySessionTokenRepository implements ISessionTokenRepository
{
    private readonly rows = new Map<string, SealedSessionTokens>()

    public async Put(row: SealedSessionTokens): Promise<void>
    {
        this.rows.set(row.SessionId, row)
    }

    public async Find(sessionId: string): Promise<SealedSessionTokens | undefined>
    {
        return this.rows.get(sessionId)
    }

    public async Delete(sessionId: string): Promise<void>
    {
        this.rows.delete(sessionId)
    }

    public async DeleteExpired(now: Date): Promise<number>
    {
        let dropped = 0
        for (const [id, row] of this.rows)
        {
            if (row.ExpiresAt.getTime() <= now.getTime())
            {
                this.rows.delete(id)
                dropped++
            }
        }
        return dropped
    }
}
