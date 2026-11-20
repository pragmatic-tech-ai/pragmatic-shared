import type { SessionRecord } from './session-record.js'

/** Where sessions live, keyed by session id (the token digest). ReplaceSubject is atomic: when it fails nothing
 *  changed. */
export interface ISessionRepository
{
    Insert(record: SessionRecord): Promise<void>
    Find(id: string): Promise<SessionRecord | null>
    /** Whether a session was there. */
    Delete(id: string): Promise<boolean>
    /** Ends every session of the subject; returns how many. */
    DeleteSubject(subject: string): Promise<number>
    /** Ends every session of the subject and stores `fresh`, in one step; returns how many ended. */
    ReplaceSubject(subject: string, fresh: SessionRecord): Promise<number>
    /** Moves a session's expiry and kept time; whether it was there. */
    Extend(id: string, expiresAt: Date, keptAt: Date): Promise<boolean>
    /** Drops sessions whose expiry is at or before `now`; returns how many. */
    DeleteExpired(now: Date): Promise<number>
}

/** Process-local sessions: for tests and single-process tools only (applications use SqlSessionRepository). */
export class InMemorySessionRepository implements ISessionRepository
{
    private readonly sessions = new Map<string, SessionRecord>()

    public async Insert(record: SessionRecord): Promise<void>
    {
        this.sessions.set(record.Id, record)
    }

    public async Find(id: string): Promise<SessionRecord | null>
    {
        return this.sessions.get(id) ?? null
    }

    public async Delete(id: string): Promise<boolean>
    {
        return this.sessions.delete(id)
    }

    public async DeleteSubject(subject: string): Promise<number>
    {
        return this.DeleteWhere(record => record.Subject === subject)
    }

    public async ReplaceSubject(subject: string, fresh: SessionRecord): Promise<number>
    {
        const ended = this.DeleteWhere(record => record.Subject === subject)
        this.sessions.set(fresh.Id, fresh)
        return ended
    }

    public async Extend(id: string, expiresAt: Date, keptAt: Date): Promise<boolean>
    {
        const record = this.sessions.get(id)
        if (record === undefined)
        {
            return false
        }
        this.sessions.set(id, record.Extended(expiresAt, keptAt))
        return true
    }

    public async DeleteExpired(now: Date): Promise<number>
    {
        return this.DeleteWhere(record => !record.IsLive(now))
    }

    private DeleteWhere(match: (record: SessionRecord) => boolean): number
    {
        let ended = 0
        for (const [id, record] of this.sessions)
        {
            if (match(record))
            {
                this.sessions.delete(id)
                ended++
            }
        }
        return ended
    }
}
