import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { AuditCheckpoint } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import type { IAuditCheckpointStore } from '@pragmatic-tech-ai/pragmatic-identity-realm'

/** Append-only store of signed audit checkpoints in a table SEPARATE from the event log
 *  (identity_audit_anchor). Independence from identity_audit is what lets SqlAuditStore.Open detect
 *  tail-truncation / whole-table rewrite; the HMAC signature (key held outside the database) is what
 *  prevents forging a checkpoint. Deleting rows from this table is out of scope (see spec §7). */
export class SqlAuditCheckpointStore implements IAuditCheckpointStore
{
    private static readonly Table = 'identity_audit_anchor'
    private static readonly LatestSql = `SELECT realm_id, seq, head_hash, at, signature FROM ${SqlAuditCheckpointStore.Table} WHERE realm_id = $1 ORDER BY seq DESC LIMIT 1`
    private static readonly InsertSql = `INSERT INTO ${SqlAuditCheckpointStore.Table} (realm_id, seq, head_hash, at, signature) VALUES ($1, $2, $3, $4, $5)`
    private static readonly RealmsSql = `SELECT DISTINCT realm_id FROM ${SqlAuditCheckpointStore.Table}`

    private readonly session: ISqlSession

    private constructor(session: ISqlSession)
    {
        this.session = session
    }

    public static async Open(session: ISqlSession): Promise<SqlAuditCheckpointStore>
    {
        await session.Execute(`CREATE TABLE IF NOT EXISTS ${SqlAuditCheckpointStore.Table} (realm_id text, seq integer, head_hash text, at text, signature text)`, [])
        await session.Execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${SqlAuditCheckpointStore.Table}_pk ON ${SqlAuditCheckpointStore.Table} (realm_id, seq)`, [])
        return new SqlAuditCheckpointStore(session)
    }

    public async Latest(realmId: string): Promise<AuditCheckpoint | undefined>
    {
        const rows = await this.session.Query(SqlAuditCheckpointStore.LatestSql, [realmId])
        if (rows.length === 0)
        {
            return undefined
        }
        return SqlAuditCheckpointStore.ToCheckpoint(rows[0]!)
    }

    public async Append(checkpoint: AuditCheckpoint): Promise<void>
    {
        await this.session.Execute(SqlAuditCheckpointStore.InsertSql, [checkpoint.RealmId, checkpoint.Sequence, checkpoint.HeadHash, checkpoint.At, checkpoint.Signature])
    }

    public async Realms(): Promise<readonly string[]>
    {
        const rows = await this.session.Query(SqlAuditCheckpointStore.RealmsSql, [])
        return rows.map(r => String(r.realm_id))
    }

    private static ToCheckpoint(row: SqlRow): AuditCheckpoint
    {
        return new AuditCheckpoint(String(row.realm_id), Number(row.seq), String(row.head_hash), String(row.at), String(row.signature))
    }
}
