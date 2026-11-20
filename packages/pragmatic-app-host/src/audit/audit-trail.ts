import { AuditEntry } from './audit-entry.js'
import type { IAuditRepository } from './audit-repository.js'

export interface AuditTrailOptions
{
    /** Targets longer than this are cut (default 512). */
    MaxTargetLength?: number
    /** Receives a failed write's error name (never its message). Default console.error. */
    Log?: (...items: unknown[]) => void
    Now?: () => Date
}

/**
 * Best-effort audit writes: Record never throws and never changes the response it follows (a failed write logs only the
 * error's name); every write is tracked until it ends, so the host's Close can await them with Drain.
 */
export class AuditTrail
{
    private static readonly DefaultMaxTargetLength = 512
    private static readonly LogPrefix = '[app-host] audit write failed:'
    private static readonly UnknownErrorName = 'Error'

    private readonly pending = new Set<Promise<void>>()
    private readonly maxTargetLength: number
    private readonly log: (...items: unknown[]) => void
    private readonly now: () => Date

    public constructor(public readonly Repository: IAuditRepository, options: AuditTrailOptions = {})
    {
        this.maxTargetLength = options.MaxTargetLength ?? AuditTrail.DefaultMaxTargetLength
        this.log = options.Log ?? console.error
        this.now = options.Now ?? (() => new Date())
    }

    public async Record(actor: string, action: string, target: string, status: number, note?: string): Promise<void>
    {
        const write = this.Write(AuditEntry.Create(actor, action, target.slice(0, this.maxTargetLength), status, this.now(), note))
        this.pending.add(write)
        try
        {
            await write
        }
        finally
        {
            this.pending.delete(write)
        }
    }

    /** Resolves once no write is still running. */
    public async Drain(): Promise<void>
    {
        await Promise.all([...this.pending])
    }

    private async Write(entry: AuditEntry): Promise<void>
    {
        try
        {
            await this.Repository.Append(entry)
        }
        catch (err)
        {
            this.log(AuditTrail.LogPrefix, err instanceof Error ? err.name : AuditTrail.UnknownErrorName)
        }
    }
}
