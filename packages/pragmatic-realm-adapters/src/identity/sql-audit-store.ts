import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { AuditEvent } from '@pragmatic-tech-ai/pragmatic-identity'
import type { AuditEventKind, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import { AuditTamperDetected, HashChainedAuditSink } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import type { AuditAnchoring, ChainedAuditRecord } from '@pragmatic-tech-ai/pragmatic-identity-realm'

/** Postgres-backed audit sink. Persists each event's chain hash and prev_hash alongside the raw event and VERIFIES
 *  them on Open: the chain is recomputed from the persisted events and compared with the persisted hashes. Any
 *  mismatch, or a gap/reorder in the per-realm sequence, makes Open throw AuditTamperDetected (fail-closed).
 *
 *  Legacy rows written before the hash columns existed (NULL hash) are backfilled on Open, but ONLY as a
 *  pre-migration PREFIX of a realm's chain: a NULL hash after a hashed row is treated as tamper (otherwise an
 *  attacker could edit a row, null its hashes and have Open re-sign it). Accepted limitation: a crash DURING the
 *  one-time first-upgrade backfill can leave a mixed NULL/hashed chain that then fails Open. Rewriting the whole
 *  table consistently is out of scope here (covered by the external-anchoring Feature).
 *
 *  Record is serialized per realm through a promise queue. The sequence comes from the in-memory chain (no
 *  MAX(seq) query) and the event is inserted BEFORE it is appended to the chain, so a rejected insert (unique
 *  conflict) never leaves the losing event in the in-memory chain. */
export class SqlAuditStore implements IAuditSink
{
    private static readonly Table = 'identity_audit'
    private static readonly HashColumn = 'hash'
    private static readonly PrevHashColumn = 'prev_hash'
    private static readonly SelectSql = `SELECT realm_id, seq, kind, principal_id, at, detail, ${SqlAuditStore.HashColumn}, ${SqlAuditStore.PrevHashColumn} FROM ${SqlAuditStore.Table} ORDER BY realm_id, seq`
    private static readonly UpdateSql = `UPDATE ${SqlAuditStore.Table} SET ${SqlAuditStore.HashColumn} = $1, ${SqlAuditStore.PrevHashColumn} = $2 WHERE realm_id = $3 AND seq = $4`
    private static readonly InsertSql = `INSERT INTO ${SqlAuditStore.Table} (realm_id, seq, kind, principal_id, at, detail, ${SqlAuditStore.HashColumn}, ${SqlAuditStore.PrevHashColumn}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

    private readonly session: ISqlSession
    private readonly chain: HashChainedAuditSink
    private readonly writes = new Map<string, Promise<unknown>>()
    private readonly anchoring?: AuditAnchoring

    private constructor(session: ISqlSession, chain: HashChainedAuditSink, anchoring?: AuditAnchoring)
    {
        this.session = session
        this.chain = chain
        this.anchoring = anchoring
    }

    private static AddColumnSql(column: string): string
    {
        return `ALTER TABLE ${SqlAuditStore.Table} ADD COLUMN ${column} text`
    }

    public static async Open(session: ISqlSession, anchoring?: AuditAnchoring): Promise<SqlAuditStore>
    {
        await session.Execute(`CREATE TABLE IF NOT EXISTS ${SqlAuditStore.Table} (realm_id text, seq integer, kind integer, principal_id text, at text, detail text)`, [])
        await session.Execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${SqlAuditStore.Table}_pk ON ${SqlAuditStore.Table} (realm_id, seq)`, [])
        for (const column of [SqlAuditStore.HashColumn, SqlAuditStore.PrevHashColumn])
        {
            try
            {
                await session.Execute(SqlAuditStore.AddColumnSql(column), [])
            }
            catch
            {
                // Idempotent migration: the expected case is a duplicate-column error on reopen. This catch
                // swallows ANY ALTER failure by design (no portable error code across pg drivers); a genuine
                // schema/connectivity failure is not hidden — it surfaces on the SELECT/INSERT that follow.
            }
        }
        const chain = new HashChainedAuditSink()
        const hashedRealms = new Set<string>()
        const realms = new Set<string>()
        const rows = await session.Query(SqlAuditStore.SelectSql, [])
        for (const row of rows)
        {
            const event = SqlAuditStore.ToEvent(row)
            realms.add(event.RealmId)
            const expected = chain.Next(event.RealmId, event)
            if (Number(row.seq) !== expected.Sequence)
            {
                throw new AuditTamperDetected(event.RealmId, expected.Sequence)
            }
            const hash = row[SqlAuditStore.HashColumn]
            const prevHash = row[SqlAuditStore.PrevHashColumn]
            if (hash === null || hash === undefined)
            {
                if (hashedRealms.has(event.RealmId))
                {
                    throw new AuditTamperDetected(event.RealmId, expected.Sequence)
                }
                await session.Execute(SqlAuditStore.UpdateSql, [expected.Hash, expected.PrevHash, event.RealmId, expected.Sequence])
            }
            else
            {
                if (String(hash) !== expected.Hash || String(prevHash) !== expected.PrevHash)
                {
                    throw new AuditTamperDetected(event.RealmId, expected.Sequence)
                }
                hashedRealms.add(event.RealmId)
            }
            chain.Append(expected)
        }
        if (anchoring !== undefined)
        {
            await anchoring.VerifyAll(chain, [...realms])
        }
        return new SqlAuditStore(session, chain, anchoring)
    }

    public async Record(event: AuditEvent): Promise<void>
    {
        const prior = this.writes.get(event.RealmId) ?? Promise.resolve()
        const mine = prior.then(() => this.DoRecord(event), () => this.DoRecord(event))
        const tail = mine.then(() => undefined, () => undefined)
        this.writes.set(event.RealmId, tail)
        void tail.then(() =>
        {
            if (this.writes.get(event.RealmId) === tail)
            {
                this.writes.delete(event.RealmId)
            }
        })
        await mine
    }

    private async DoRecord(event: AuditEvent): Promise<void>
    {
        const next = this.chain.Next(event.RealmId, event)
        const detail = JSON.stringify([...event.Detail])
        await this.session.Execute(SqlAuditStore.InsertSql, [event.RealmId, next.Sequence, event.Kind, event.PrincipalId, event.At.toISOString(), detail, next.Hash, next.PrevHash])
        this.chain.Append(next)
        // The row is already inserted and chained above; a throw here only defers this event's
        // checkpoint — caught as an un-anchored tail on the next Open, never a checkpoint ahead of its event.
        if (this.anchoring !== undefined)
        {
            await this.anchoring.CheckpointIfDue(event.RealmId, this.chain.Records(event.RealmId))
        }
    }

    public Verify(realmId: string): boolean
    {
        return this.chain.Verify(realmId)
    }

    public Records(realmId: string): readonly ChainedAuditRecord[]
    {
        return this.chain.Records(realmId)
    }

    private static ToEvent(row: SqlRow): AuditEvent
    {
        const detail = JSON.parse(String(row.detail)) as Array<[string, string]>
        return new AuditEvent(Number(row.kind) as AuditEventKind, String(row.realm_id), row.principal_id === null ? null : String(row.principal_id), new Date(String(row.at)), new Map(detail))
    }
}
