import type { IProtocolClock } from './protocol-clock.js'
import type { Participant } from './participant.js'

/**
 * Remembers every nonce seen per issuer until its message can no longer be fresh. `Claim` is atomic: of two
 * concurrent claims of one nonce exactly one succeeds. The platform keeps one per channel host (Postgres-backed in
 * production); a hive keeps one for the intents it receives.
 */
export interface INonceLedger
{
    /** True the first time `nonce` is claimed for `issuer`; false when it was already seen. Kept until `keepUntil`. */
    Claim(issuer: Participant, nonce: string, keepUntil: Date): Promise<boolean>
}

/** A process-local ledger: entries are dropped once their keep-until time has passed. */
export class InMemoryNonceLedger implements INonceLedger
{
    private static readonly Separator = '\u0000'
    private readonly entries = new Map<string, number>()

    public constructor(private readonly clock: IProtocolClock)
    {
    }

    public get Size(): number
    {
        return this.entries.size
    }

    public Claim(issuer: Participant, nonce: string, keepUntil: Date): Promise<boolean>
    {
        const now = this.clock.Now().getTime()
        for (const [key, until] of this.entries)
        {
            if (until < now)
            {
                this.entries.delete(key)
            }
        }
        const key = issuer.Key + InMemoryNonceLedger.Separator + nonce
        if (this.entries.has(key))
        {
            return Promise.resolve(false)
        }
        this.entries.set(key, keepUntil.getTime())
        return Promise.resolve(true)
    }
}
