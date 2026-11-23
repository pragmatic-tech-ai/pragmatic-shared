import { createHash } from 'node:crypto'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { AuditEvent } from '@pragmatic-tech-ai/pragmatic-identity'
import type { AuditEventKind, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import { AuditTamperDetected, HashChainedAuditSink } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import type { AuditAnchoring, ChainedAuditRecord } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlAuditMigrations } from './sql-identity-migrations.js'

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
 *  The DATABASE is the chain's authority: several store instances (several processes of one deployment, an
 *  environment moving between workers) may write the same realm. Each Record is one transaction that takes a
 *  per-realm transaction-scoped advisory lock, reads the realm's head row and catches the in-memory chain up to it
 *  (verifying every row another writer appended, as Open does), computes the next record from that head with the
 *  same hash chain and inserts it. The in-memory chain is only a cache of committed rows: the new record joins it
 *  after COMMIT, so a rejected insert never leaves the event in the cache. Within one instance Record and Refresh
 *  are serialized per realm through a promise queue. Records/Verify answer from the cache as of this instance's last
 *  write or Refresh; Refresh brings it up to the database head. */
export class SqlAuditStore implements IAuditSink
{
    private static readonly Table = 'identity_audit'
    private static readonly HashColumn = 'hash'
    private static readonly PrevHashColumn = 'prev_hash'
    private static readonly Columns = `realm_id, seq, kind, principal_id, at, detail, ${SqlAuditStore.HashColumn}, ${SqlAuditStore.PrevHashColumn}`
    private static readonly SelectSql = `SELECT ${SqlAuditStore.Columns} FROM ${SqlAuditStore.Table} ORDER BY realm_id, seq`
    private static readonly HeadSql = `SELECT seq, ${SqlAuditStore.HashColumn} FROM ${SqlAuditStore.Table} WHERE realm_id = $1 ORDER BY seq DESC LIMIT 1`
    private static readonly TailSql = `SELECT ${SqlAuditStore.Columns} FROM ${SqlAuditStore.Table} WHERE realm_id = $1 AND seq >= $2 ORDER BY seq`
    private static readonly UpdateSql = `UPDATE ${SqlAuditStore.Table} SET ${SqlAuditStore.HashColumn} = $1, ${SqlAuditStore.PrevHashColumn} = $2 WHERE realm_id = $3 AND seq = $4`
    private static readonly InsertSql = `INSERT INTO ${SqlAuditStore.Table} (${SqlAuditStore.Columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
    private static readonly LockSql = 'SELECT pg_advisory_xact_lock($1)'
    /** Namespaces the per-realm lock keys, so they are not by design equal to another feature's advisory lock keys. */
    private static readonly LockNamespace = 'pragmatic.identity_audit\u0000'
    private static readonly LockDigest = 'sha256'
    private static readonly NoTransaction = 'SqlAuditStore needs an ISqlSession that supports Transaction'

    private readonly session: ISqlSession
    private readonly chain: HashChainedAuditSink
    private readonly queues = new Map<string, Promise<unknown>>()
    private readonly anchoring?: AuditAnchoring

    private constructor(session: ISqlSession, chain: HashChainedAuditSink, anchoring?: AuditAnchoring)
    {
        this.session = session
        this.chain = chain
        this.anchoring = anchoring
    }

    public static async Open(session: ISqlSession, anchoring?: AuditAnchoring): Promise<SqlAuditStore>
    {
        await SqlMigrationRunner.Run(session, new SqlAuditMigrations())
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
                SqlAuditStore.CheckHashes(row, expected)
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

    /** The stable advisory-lock key of a realm's audit chain: the first 63 bits of a namespaced SHA-256 of the realm
     *  id, as a decimal string (a non-negative bigint every process derives identically). */
    public static LockKey(realmId: string): string
    {
        const digest = createHash(SqlAuditStore.LockDigest).update(SqlAuditStore.LockNamespace + realmId).digest()
        return (digest.readBigUInt64BE(0) >> 1n).toString()
    }

    public Record(event: AuditEvent): Promise<void>
    {
        return this.Enqueue(event.RealmId, () => this.DoRecord(event))
    }

    /** Brings the cached chain of `realmId` up to the database head (rows other writers committed), verifying them. */
    public Refresh(realmId: string): Promise<void>
    {
        return this.Enqueue(realmId, () => this.CatchUp(this.session, realmId))
    }

    public Verify(realmId: string): boolean
    {
        return this.chain.Verify(realmId)
    }

    public Records(realmId: string): readonly ChainedAuditRecord[]
    {
        return this.chain.Records(realmId)
    }

    private async Enqueue(realmId: string, work: () => Promise<void>): Promise<void>
    {
        const prior = this.queues.get(realmId) ?? Promise.resolve()
        const mine = prior.then(work, work)
        const tail = mine.then(() => undefined, () => undefined)
        this.queues.set(realmId, tail)
        void tail.then(() =>
        {
            if (this.queues.get(realmId) === tail)
            {
                this.queues.delete(realmId)
            }
        })
        await mine
    }

    private async DoRecord(event: AuditEvent): Promise<void>
    {
        if (this.session.Transaction === undefined)
        {
            throw new Error(SqlAuditStore.NoTransaction)
        }
        const next = await this.session.Transaction(async tx =>
        {
            await tx.Query(SqlAuditStore.LockSql, [SqlAuditStore.LockKey(event.RealmId)])
            await this.CatchUp(tx, event.RealmId)
            const record = this.chain.Next(event.RealmId, event)
            const detail = JSON.stringify([...event.Detail])
            await tx.Execute(SqlAuditStore.InsertSql, [event.RealmId, record.Sequence, event.Kind, event.PrincipalId, event.At.toISOString(), detail, record.Hash, record.PrevHash])
            return record
        })
        this.chain.Append(next)
        // The row is already committed and chained above; a throw here only defers this event's
        // checkpoint — caught as an un-anchored tail on the next Open, never a checkpoint ahead of its event.
        if (this.anchoring !== undefined)
        {
            await this.anchoring.CheckpointIfDue(event.RealmId, this.chain.Records(event.RealmId))
        }
    }

    /** Reads the realm's head row and appends every committed row past the cache to the cache, verified. A head
     *  behind the cache (rows deleted) or a head whose hash differs from the cached one (rows rewritten) is tamper. */
    private async CatchUp(session: ISqlSession, realmId: string): Promise<void>
    {
        const cached = this.chain.Records(realmId)
        const heads = await session.Query(SqlAuditStore.HeadSql, [realmId])
        const headSeq = heads.length === 0 ? -1 : Number(heads[0]!.seq)
        if (headSeq < cached.length - 1)
        {
            throw new AuditTamperDetected(realmId, headSeq + 1)
        }
        if (headSeq === cached.length - 1)
        {
            if (headSeq >= 0 && String(heads[0]![SqlAuditStore.HashColumn]) !== cached[headSeq]!.Hash)
            {
                throw new AuditTamperDetected(realmId, headSeq)
            }
            return
        }
        const rows = await session.Query(SqlAuditStore.TailSql, [realmId, cached.length])
        for (const row of rows)
        {
            const expected = this.chain.Next(realmId, SqlAuditStore.ToEvent(row))
            if (Number(row.seq) !== expected.Sequence)
            {
                throw new AuditTamperDetected(realmId, expected.Sequence)
            }
            SqlAuditStore.CheckHashes(row, expected)
            this.chain.Append(expected)
        }
        const caughtUp = this.chain.Records(realmId).length
        if (caughtUp !== headSeq + 1)
        {
            throw new AuditTamperDetected(realmId, caughtUp)
        }
    }

    /** A hashed row must carry exactly the hash and prev_hash the chain recomputes for it (a NULL hash is tamper). */
    private static CheckHashes(row: SqlRow, expected: ChainedAuditRecord): void
    {
        const hash = row[SqlAuditStore.HashColumn]
        const prevHash = row[SqlAuditStore.PrevHashColumn]
        if (hash === null || hash === undefined || String(hash) !== expected.Hash || String(prevHash) !== expected.PrevHash)
        {
            throw new AuditTamperDetected(expected.Event.RealmId, expected.Sequence)
        }
    }

    private static ToEvent(row: SqlRow): AuditEvent
    {
        const detail = JSON.parse(String(row.detail)) as Array<[string, string]>
        return new AuditEvent(Number(row.kind) as AuditEventKind, String(row.realm_id), row.principal_id === null ? null : String(row.principal_id), new Date(String(row.at)), new Map(detail))
    }
}
