import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { AuditEntry } from './audit-entry.js'
import type { IAuditRepository } from './audit-repository.js'

/** Schema of the application audit trail. */
export class SqlAuditMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE app_host_audit (id text PRIMARY KEY, actor text NOT NULL, anonymous boolean NOT NULL, action text NOT NULL, target text NOT NULL, status integer NOT NULL, at timestamptz NOT NULL, note text)',
        'CREATE INDEX app_host_audit_at ON app_host_audit (at)',
    ])

    public readonly Name = 'app_host.audit'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlAuditMigrations.V1]
    }
}

/**
 * Postgres IAuditRepository. Capped like the in-memory trail (default 100 000 entries): after an append that passes the
 * cap, the excess is deleted, oldest anonymous entries first, authored ones only when no anonymous entry remains.
 */
export class SqlAuditRepository implements IAuditRepository
{
    private static readonly DefaultMaxEntries = 100_000
    private static readonly InsertSql = 'INSERT INTO app_host_audit (id, actor, anonymous, action, target, status, at, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)'
    private static readonly CountSql = 'SELECT count(*) AS n FROM app_host_audit'
    private static readonly OldestSql = 'SELECT id FROM app_host_audit ORDER BY anonymous DESC, at ASC LIMIT $1'
    private static readonly DeleteSql = 'DELETE FROM app_host_audit WHERE id = $1'
    private static readonly RecentSql = 'SELECT id, actor, action, target, status, at, note FROM app_host_audit ORDER BY at DESC LIMIT $1'

    private constructor(private readonly session: ISqlSession, private readonly maxEntries: number)
    {
    }

    public static async Open(session: ISqlSession, maxEntries: number = SqlAuditRepository.DefaultMaxEntries): Promise<SqlAuditRepository>
    {
        await SqlMigrationRunner.Run(session, new SqlAuditMigrations())
        return new SqlAuditRepository(session, maxEntries)
    }

    public async Append(entry: AuditEntry): Promise<void>
    {
        await this.session.Execute(SqlAuditRepository.InsertSql, [entry.Id, entry.Actor, entry.IsAnonymous, entry.Action, entry.Target, entry.Status, entry.At, entry.Note ?? null])
        const count = Number((await this.session.Query(SqlAuditRepository.CountSql, []))[0]?.n ?? 0)
        if (count <= this.maxEntries)
        {
            return
        }
        for (const row of await this.session.Query(SqlAuditRepository.OldestSql, [count - this.maxEntries]))
        {
            await this.session.Execute(SqlAuditRepository.DeleteSql, [row.id])
        }
    }

    public async Recent(limit: number): Promise<readonly AuditEntry[]>
    {
        return (await this.session.Query(SqlAuditRepository.RecentSql, [limit])).map(row => SqlAuditRepository.ToEntry(row))
    }

    private static ToEntry(row: SqlRow): AuditEntry
    {
        const note = row.note === null || row.note === undefined ? undefined : String(row.note)
        return new AuditEntry(String(row.id), String(row.actor), String(row.action), String(row.target), Number(row.status), new Date(row.at as string | Date), note)
    }
}
