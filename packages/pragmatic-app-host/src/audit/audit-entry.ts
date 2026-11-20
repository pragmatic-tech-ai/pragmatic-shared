import { randomUUID } from 'node:crypto'

/** One audited operation: who (Actor), what (Action: the HTTP method), on what (Target: the path, never the query),
 *  the final status, when, and an optional note on what it kept or skipped (never secret material). */
export class AuditEntry
{
    /** The actor of a request that had no signed-in subject. Evicted first, so a flood cannot push out authored history. */
    public static readonly AnonymousActor = '(anonymous)'

    public constructor(
        public readonly Id: string,
        public readonly Actor: string,
        public readonly Action: string,
        public readonly Target: string,
        public readonly Status: number,
        public readonly At: Date,
        public readonly Note?: string)
    {
    }

    public static Create(actor: string, action: string, target: string, status: number, at: Date, note?: string): AuditEntry
    {
        return new AuditEntry(randomUUID(), actor, action, target, status, at, note)
    }

    public get IsAnonymous(): boolean
    {
        return this.Actor === AuditEntry.AnonymousActor
    }
}
