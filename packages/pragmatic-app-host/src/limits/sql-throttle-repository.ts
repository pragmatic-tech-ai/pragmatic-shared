import { createHash } from 'node:crypto'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IThrottleRepository } from './throttle-repository.js'
import { ThrottleState } from './throttle-state.js'

/** Schema of the persistent throttle state (times are epoch milliseconds). */
export class SqlThrottleMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE app_host_throttles (key text PRIMARY KEY, count integer NOT NULL, window_start bigint NOT NULL, locked_until bigint NOT NULL, expires_at bigint NOT NULL)',
        'CREATE INDEX app_host_throttles_expires ON app_host_throttles (expires_at)',
    ])

    public readonly Name = 'app_host.throttles'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlThrottleMigrations.V1]
    }
}

/**
 * Postgres IThrottleRepository: one throttle shared by every replica and kept across restarts. Update runs in one
 * transaction that first takes a transaction-scoped advisory lock derived from the key (so concurrent Updates of one
 * key, from any replica, serialise), reads the state, applies the change and upserts it. States that expired are swept
 * on each Update and read as absent.
 */
export class SqlThrottleRepository implements IThrottleRepository
{
    private static readonly LockSql = 'SELECT pg_advisory_xact_lock($1)'
    private static readonly GetSql = 'SELECT count, window_start, locked_until, expires_at FROM app_host_throttles WHERE key = $1'
    private static readonly UpsertSql = 'INSERT INTO app_host_throttles (key, count, window_start, locked_until, expires_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, window_start = EXCLUDED.window_start, locked_until = EXCLUDED.locked_until, expires_at = EXCLUDED.expires_at'
    private static readonly DeleteSql = 'DELETE FROM app_host_throttles WHERE key = $1'
    private static readonly SweepSql = 'DELETE FROM app_host_throttles WHERE expires_at <= $1'
    private static readonly TransactionRequiredMessage = 'SqlThrottleRepository needs a session that supports transactions'
    private static readonly HashAlgorithm = 'sha256'
    /** Keeps throttle locks apart from other advisory-lock users (the migration runner's key is a fixed constant). */
    private static readonly LockNamespace = 'app_host.throttles:'
    private static readonly LockKeyBits = 64

    private constructor(private readonly session: ISqlSession, private readonly now: () => number)
    {
    }

    public static async Open(session: ISqlSession, now: () => number = Date.now): Promise<SqlThrottleRepository>
    {
        await SqlMigrationRunner.Run(session, new SqlThrottleMigrations())
        return new SqlThrottleRepository(session, now)
    }

    public async Get(key: string): Promise<ThrottleState | undefined>
    {
        const row = (await this.session.Query(SqlThrottleRepository.GetSql, [key]))[0]
        const state = row === undefined ? undefined : SqlThrottleRepository.ToState(row)
        return state === undefined || state.IsExpired(this.now()) ? undefined : state
    }

    public async Update(key: string, change: (prior: ThrottleState | undefined) => ThrottleState): Promise<ThrottleState>
    {
        if (this.session.Transaction === undefined)
        {
            throw new Error(SqlThrottleRepository.TransactionRequiredMessage)
        }
        await this.session.Execute(SqlThrottleRepository.SweepSql, [this.now()])
        return await this.session.Transaction(async tx =>
        {
            await tx.Query(SqlThrottleRepository.LockSql, [SqlThrottleRepository.LockKey(key)])
            const row = (await tx.Query(SqlThrottleRepository.GetSql, [key]))[0]
            const prior = row === undefined ? undefined : SqlThrottleRepository.ToState(row)
            const next = change(prior === undefined || prior.IsExpired(this.now()) ? undefined : prior)
            await tx.Execute(SqlThrottleRepository.UpsertSql, [key, next.Count, next.WindowStart, next.LockedUntil, next.ExpiresAt])
            return next
        })
    }

    public async Delete(key: string): Promise<void>
    {
        await this.session.Execute(SqlThrottleRepository.DeleteSql, [key])
    }

    /** A signed 64-bit advisory-lock key (decimal text) from the key's digest. */
    private static LockKey(key: string): string
    {
        const digest = createHash(SqlThrottleRepository.HashAlgorithm).update(SqlThrottleRepository.LockNamespace + key).digest()
        return BigInt.asIntN(SqlThrottleRepository.LockKeyBits, digest.readBigUInt64BE(0)).toString()
    }

    private static ToState(row: SqlRow): ThrottleState
    {
        return new ThrottleState(Number(row.count), Number(row.window_start), Number(row.locked_until), Number(row.expires_at))
    }
}
