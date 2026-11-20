import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { ISessionRepository } from './session-repository.js'
import { SessionRecord } from './session-record.js'
import { SessionClaims } from './session-claims.js'
import { SessionPolicy } from './session-policy.js'

/** Schema of the application sessions: one row per session, keyed by the token digest (never the token). */
export class SqlSessionMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE app_host_sessions (id text PRIMARY KEY, subject text NOT NULL, claims text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, kept_at timestamptz NOT NULL, ttl_ms bigint NOT NULL, renewal_interval_ms bigint NOT NULL, max_lifetime_ms bigint NOT NULL)',
        'CREATE INDEX app_host_sessions_subject ON app_host_sessions (subject)',
        'CREATE INDEX app_host_sessions_expires ON app_host_sessions (expires_at)',
    ])

    public readonly Name = 'app_host.sessions'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlSessionMigrations.V1]
    }
}

/** Postgres ISessionRepository: sessions survive a restart and are shared by every replica. ReplaceSubject runs its
 *  delete and insert in one transaction. */
export class SqlSessionRepository implements ISessionRepository
{
    private static readonly Columns = 'id, subject, claims, issued_at, expires_at, kept_at, ttl_ms, renewal_interval_ms, max_lifetime_ms'
    private static readonly InsertSql = `INSERT INTO app_host_sessions (${SqlSessionRepository.Columns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
    private static readonly FindSql = `SELECT ${SqlSessionRepository.Columns} FROM app_host_sessions WHERE id = $1`
    private static readonly DeleteSql = 'DELETE FROM app_host_sessions WHERE id = $1'
    private static readonly DeleteSubjectSql = 'DELETE FROM app_host_sessions WHERE subject = $1'
    private static readonly SubjectClaimsSql = 'SELECT id, claims FROM app_host_sessions WHERE subject = $1'
    private static readonly ExtendSql = 'UPDATE app_host_sessions SET expires_at = $2, kept_at = $3 WHERE id = $1'
    private static readonly DeleteExpiredSql = 'DELETE FROM app_host_sessions WHERE expires_at <= $1'
    private static readonly TransactionRequiredMessage = 'SqlSessionRepository needs a session that supports transactions'

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlSessionRepository>
    {
        await SqlMigrationRunner.Run(session, new SqlSessionMigrations())
        return new SqlSessionRepository(session)
    }

    public async Insert(record: SessionRecord): Promise<void>
    {
        await SqlSessionRepository.InsertOn(this.session, record)
    }

    public async Find(id: string): Promise<SessionRecord | null>
    {
        const row = (await this.session.Query(SqlSessionRepository.FindSql, [id]))[0]
        return row === undefined ? null : SqlSessionRepository.ToRecord(row)
    }

    public async Delete(id: string): Promise<boolean>
    {
        return await this.session.Execute(SqlSessionRepository.DeleteSql, [id]) > 0
    }

    public async DeleteSubject(subject: string): Promise<number>
    {
        return await this.session.Execute(SqlSessionRepository.DeleteSubjectSql, [subject])
    }

    /** The subject's rows are read and matched on their claims here (claims are stored as JSON text), then deleted by id. */
    public async DeleteSubjectWithClaim(subject: string, claim: string, value: string): Promise<number>
    {
        const R = SqlSessionRepository
        let ended = 0
        for (const row of await this.session.Query(R.SubjectClaimsSql, [subject]))
        {
            if (SessionClaims.FromJson(String(row.claims)).Has(claim, value) && await this.session.Execute(R.DeleteSql, [String(row.id)]) > 0)
            {
                ended++
            }
        }
        return ended
    }

    public async ReplaceSubject(subject: string, fresh: SessionRecord): Promise<number>
    {
        if (this.session.Transaction === undefined)
        {
            throw new Error(SqlSessionRepository.TransactionRequiredMessage)
        }
        return await this.session.Transaction(async tx =>
        {
            const ended = await tx.Execute(SqlSessionRepository.DeleteSubjectSql, [subject])
            await SqlSessionRepository.InsertOn(tx, fresh)
            return ended
        })
    }

    public async Extend(id: string, expiresAt: Date, keptAt: Date): Promise<boolean>
    {
        return await this.session.Execute(SqlSessionRepository.ExtendSql, [id, expiresAt, keptAt]) > 0
    }

    public async DeleteExpired(now: Date): Promise<number>
    {
        return await this.session.Execute(SqlSessionRepository.DeleteExpiredSql, [now])
    }

    private static async InsertOn(session: ISqlSession, record: SessionRecord): Promise<void>
    {
        await session.Execute(SqlSessionRepository.InsertSql, [
            record.Id,
            record.Subject,
            JSON.stringify(record.Claims.ToJson()),
            record.IssuedAt,
            record.ExpiresAt,
            record.KeptAt,
            record.Policy.TtlMs,
            record.Policy.RenewalIntervalMs,
            record.Policy.MaxLifetimeMs,
        ])
    }

    private static ToRecord(row: SqlRow): SessionRecord
    {
        return new SessionRecord(
            String(row.id),
            String(row.subject),
            SessionClaims.FromJson(String(row.claims)),
            SqlSessionRepository.ToDate(row.issued_at),
            SqlSessionRepository.ToDate(row.expires_at),
            SqlSessionRepository.ToDate(row.kept_at),
            new SessionPolicy(Number(row.ttl_ms), Number(row.renewal_interval_ms), Number(row.max_lifetime_ms)))
    }

    private static ToDate(value: unknown): Date
    {
        return new Date(value as string | Date)
    }
}
