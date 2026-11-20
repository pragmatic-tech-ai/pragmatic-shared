import type { AuditEntry } from './audit-entry.js'

/** Where the audit trail lives. Bounded: past its cap the oldest anonymous entries go first, authored ones only when no
 *  anonymous entry remains, oldest by time. */
export interface IAuditRepository
{
    Append(entry: AuditEntry): Promise<void>
    /** Newest first, at most `limit`. */
    Recent(limit: number): Promise<readonly AuditEntry[]>
}

/** Process-local audit trail, for tests and single-process tools only. */
export class InMemoryAuditRepository implements IAuditRepository
{
    private static readonly DefaultMaxEntries = 1000

    private entries: AuditEntry[] = []

    public constructor(private readonly maxEntries: number = InMemoryAuditRepository.DefaultMaxEntries)
    {
    }

    public async Append(entry: AuditEntry): Promise<void>
    {
        this.entries.push(entry)
        if (this.entries.length <= this.maxEntries)
        {
            return
        }
        const byAge = [...this.entries].sort((a, b) => a.At.getTime() - b.At.getTime())
        const victims = new Set([...byAge.filter(e => e.IsAnonymous), ...byAge.filter(e => !e.IsAnonymous)].slice(0, this.entries.length - this.maxEntries))
        this.entries = this.entries.filter(e => !victims.has(e))
    }

    public async Recent(limit: number): Promise<readonly AuditEntry[]>
    {
        return [...this.entries].sort((a, b) => b.At.getTime() - a.At.getTime()).slice(0, limit)
    }
}
