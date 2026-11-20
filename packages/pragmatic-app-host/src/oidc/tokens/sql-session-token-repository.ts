import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SealedSessionTokens } from './session-token-repository.js'
import type { ISessionTokenRepository } from './session-token-repository.js'

/** Schema of the sealed session tokens (expiry in epoch milliseconds). */
export class SqlSessionTokenMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE app_host_session_tokens (session_id text PRIMARY KEY, sealed text NOT NULL, expires_at bigint NOT NULL)',
        'CREATE INDEX app_host_session_tokens_expires ON app_host_session_tokens (expires_at)',
    ])

    public readonly Name = 'app_host.session_tokens'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlSessionTokenMigrations.V1]
    }
}

/** Postgres ISessionTokenRepository: a session's tokens are visible to every replica (a refresh on one is seen by all). */
export class SqlSessionTokenRepository implements ISessionTokenRepository
{
    private static readonly PutSql = 'INSERT INTO app_host_session_tokens (session_id, sealed, expires_at) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO UPDATE SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at'
    private static readonly FindSql = 'SELECT session_id, sealed, expires_at FROM app_host_session_tokens WHERE session_id = $1'
    private static readonly DeleteSql = 'DELETE FROM app_host_session_tokens WHERE session_id = $1'
    private static readonly DeleteExpiredSql = 'DELETE FROM app_host_session_tokens WHERE expires_at <= $1 RETURNING session_id'

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlSessionTokenRepository>
    {
        await SqlMigrationRunner.Run(session, new SqlSessionTokenMigrations())
        return new SqlSessionTokenRepository(session)
    }

    public async Put(row: SealedSessionTokens): Promise<void>
    {
        await this.session.Execute(SqlSessionTokenRepository.PutSql, [row.SessionId, row.Sealed, row.ExpiresAt.getTime()])
    }

    public async Find(sessionId: string): Promise<SealedSessionTokens | undefined>
    {
        const row = (await this.session.Query(SqlSessionTokenRepository.FindSql, [sessionId]))[0]
        if (row === undefined)
        {
            return undefined
        }
        return new SealedSessionTokens(String(row.session_id), String(row.sealed), new Date(Number(row.expires_at)))
    }

    public async Delete(sessionId: string): Promise<void>
    {
        await this.session.Execute(SqlSessionTokenRepository.DeleteSql, [sessionId])
    }

    public async DeleteExpired(now: Date): Promise<number>
    {
        return (await this.session.Query(SqlSessionTokenRepository.DeleteExpiredSql, [now.getTime()])).length
    }
}
