import type { Pool, PoolClient } from 'pg'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'

/** A clean ISqlSession over a pg.Pool for the SQL stores. It does NOT mask undefined-table errors as empty results:
 *  every table is created by its store's migrations (SqlMigrationRunner), so a missing table is a real fault that
 *  must surface. Transaction checks one client out of the pool, runs the work on it between BEGIN and COMMIT and
 *  rolls back (rethrowing the work's error) when the work fails. */
export class PgSession implements ISqlSession
{
    private static readonly Begin = 'BEGIN'
    private static readonly Commit = 'COMMIT'
    private static readonly Rollback = 'ROLLBACK'

    private readonly pool: Pool

    public constructor(pool: Pool)
    {
        this.pool = pool
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        const result = await this.pool.query(sql, params as unknown[])
        return result.rows as readonly SqlRow[]
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        const result = await this.pool.query(sql, params as unknown[])
        return result.rowCount ?? 0
    }

    public async Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        const client = await this.pool.connect()
        try
        {
            await client.query(PgSession.Begin)
            let result: T
            try
            {
                result = await work(new PgTransactionSession(client))
            }
            catch (err)
            {
                // The work's failure is the cause the caller must see; a failed rollback must not replace it.
                await client.query(PgSession.Rollback).catch(() => undefined)
                throw err
            }
            await client.query(PgSession.Commit)
            return result
        }
        finally
        {
            client.release()
        }
    }

    public async Dispose(): Promise<void>
    {
        await this.pool.end()
    }
}

/** The ISqlSession handed to a PgSession transaction's work: one checked-out client inside BEGIN..COMMIT. A nested
 *  Transaction joins the outer one (no savepoints): its work runs on the same client and the outer transaction
 *  decides commit or rollback. */
export class PgTransactionSession implements ISqlSession
{
    private readonly client: PoolClient

    public constructor(client: PoolClient)
    {
        this.client = client
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        const result = await this.client.query(sql, params as unknown[])
        return result.rows as readonly SqlRow[]
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        const result = await this.client.query(sql, params as unknown[])
        return result.rowCount ?? 0
    }

    public Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        return work(this)
    }
}
