import { randomBytes } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import { Pool } from 'pg'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession } from '../sql/pg-session.js'

/** One live test database: a fresh schema in the PRAGMATIC_TEST_PG_URL database. Its sessions share one pool whose
 *  search_path is that schema (up to MaxConnections connections, so concurrent starters still race on separate
 *  connections) while other test databases stay isolated. Dispose ends the pool and drops the schema. Connections
 *  are reused rather than opened per session: the hive laptop reaches its WSL Postgres through a port relay, and
 *  fewer connects mean fewer chances to hit a dropped one. */
export class SqlLiveTestDatabase
{
    private static readonly SearchPathOption = '-c search_path='
    private static readonly MaxConnections = 10

    private readonly pool: Pool

    public constructor(public readonly Schema: string, url: string)
    {
        this.pool = new Pool({ connectionString: url, options: SqlLiveTestDatabase.SearchPathOption + Schema, max: SqlLiveTestDatabase.MaxConnections, allowExitOnIdle: true })
    }

    /** A session over the database's shared pool (Dispose on any of them ends the pool for all). */
    public Session(): PgSession
    {
        return new PgSession(this.pool)
    }

    public async Dispose(): Promise<void>
    {
        await this.pool.end()
        await SqlTestSessions.DropSchema(this.Schema)
    }
}

/** Runs a store's test body against an always-on pg-mem session and, when PRAGMATIC_TEST_PG_URL is set and
 *  non-empty, a gated-live real-Postgres session. `body` receives a `makeSession` that yields a FRESH session (a
 *  fresh empty pg-mem db, or a fresh live schema, per call); it registers node:test cases, labelled by backend.
 *  DescribeLive registers live-only cases (behaviour pg-mem cannot show: rollback, real locks, concurrency). */
export class SqlTestSessions
{
    private static readonly LiveEnvVar = 'PRAGMATIC_TEST_PG_URL'
    private static readonly MemLabel = 'pg-mem'
    private static readonly LiveLabel = 'live'
    private static readonly SchemaPrefix = 'pragmatic_t_'
    private static readonly SchemaPattern = /^pragmatic_t_(\d+)_[0-9a-f]+$/
    private static readonly StaleSchemaMs = 60 * 60 * 1000
    private static readonly AdvisoryXactLock = 'pg_advisory_xact_lock'
    private static readonly ListSchemasSql = 'SELECT nspname FROM pg_namespace WHERE nspname LIKE $1'
    private static readonly SchemaLike = 'pragmatic\\_t\\_%'
    private static readonly AdminConnections = 2

    private static admin: Pool | undefined
    private static staleSwept = false

    public static Describe(label: string, body: (makeSession: () => Promise<ISqlSession>, backend: string) => void): void
    {
        body(() => Promise.resolve(new PgSession(SqlTestSessions.MemPool())), `${label} [${SqlTestSessions.MemLabel}]`)
        const url = SqlTestSessions.LiveUrl()
        if (url !== '')
        {
            body(async () => (await SqlTestSessions.LiveDatabase(url)).Session(), `${label} [${SqlTestSessions.LiveLabel}]`)
        }
    }

    /** Registers `body` only when a live database is configured; `makeDatabase` yields a fresh schema per call. */
    public static DescribeLive(_label: string, body: (makeDatabase: () => Promise<SqlLiveTestDatabase>) => void): void
    {
        const url = SqlTestSessions.LiveUrl()
        if (url !== '')
        {
            body(() => SqlTestSessions.LiveDatabase(url))
        }
    }

    /** A fresh pg-mem pool. AST coverage checking is off because pg-mem leaves the column/constraint list of a
     *  `CREATE TABLE IF NOT EXISTS` unread when the table already exists (version 1 of the migrated stores keeps that
     *  form for tables created by the pre-migration code). pg-mem has no advisory locks and runs one statement at a
     *  time, so `pg_advisory_xact_lock` is registered as a no-op for the migration runner. */
    public static MemPool(): Pool
    {
        const db = newDb({ noAstCoverageCheck: true })
        db.public.registerFunction({ name: SqlTestSessions.AdvisoryXactLock, args: [DataType.bigint], returns: DataType.text, implementation: () => null, impure: true })
        const pg = db.adapters.createPg()
        return new pg.Pool() as unknown as Pool
    }

    public static async DropSchema(schema: string): Promise<void>
    {
        await SqlTestSessions.Admin(SqlTestSessions.LiveUrl()).query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }

    private static LiveUrl(): string
    {
        return process.env[SqlTestSessions.LiveEnvVar] ?? ''
    }

    /** The process-wide pool that creates and drops test schemas. */
    private static Admin(url: string): Pool
    {
        SqlTestSessions.admin ??= new Pool({ connectionString: url, max: SqlTestSessions.AdminConnections, allowExitOnIdle: true })
        return SqlTestSessions.admin
    }

    private static async LiveDatabase(url: string): Promise<SqlLiveTestDatabase>
    {
        const schema = `${SqlTestSessions.SchemaPrefix}${Date.now()}_${randomBytes(6).toString('hex')}`
        const admin = SqlTestSessions.Admin(url)
        await SqlTestSessions.SweepStaleSchemas(admin)
        await admin.query(`CREATE SCHEMA ${schema}`)
        return new SqlLiveTestDatabase(schema, url)
    }

    /** Once per process: drops test schemas older than an hour (left behind by cases that did not Dispose). */
    private static async SweepStaleSchemas(admin: Pool): Promise<void>
    {
        if (SqlTestSessions.staleSwept)
        {
            return
        }
        SqlTestSessions.staleSwept = true
        const rows = (await admin.query(SqlTestSessions.ListSchemasSql, [SqlTestSessions.SchemaLike])).rows as { nspname: string }[]
        const cutoff = Date.now() - SqlTestSessions.StaleSchemaMs
        for (const row of rows)
        {
            const match = SqlTestSessions.SchemaPattern.exec(row.nspname)
            if (match !== null && Number(match[1]) < cutoff)
            {
                await admin.query(`DROP SCHEMA IF EXISTS ${row.nspname} CASCADE`)
            }
        }
    }
}
