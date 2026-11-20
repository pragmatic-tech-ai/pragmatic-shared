import { readFile } from 'node:fs/promises'
import pg from 'pg'
import type { Pool, PoolConfig } from 'pg'
import { parseIntoClientConfig } from 'pg-connection-string'

export interface PostgresPoolOptions
{
    /** Path of the secret file holding the database URL (`postgres://user:password@host:port/db?sslmode=...`). The URL
     *  is never taken from an environment variable value or the command line: it carries the password. */
    readonly UrlFile: string
    /** Pool size (default 10). */
    readonly MaxConnections?: number
    /** Reported to Postgres as application_name (pg_stat_activity). */
    readonly ApplicationName?: string
}

/** The custom realm option's Postgres: a pg.Pool for one application's database, from a database URL read from a
 *  secret file. TLS is the URL's business: `sslmode=require|verify-ca|verify-full` turns it on, `sslrootcert=<path>`
 *  names a private CA (with `sslcert`/`sslkey` for client certificates), `sslmode=disable` or no sslmode keeps a
 *  plain connection (the hive's own `pragmatic-postgres` on the pod network). Errors never echo the URL. */
export class PostgresPoolFactory
{
    private static readonly DefaultMaxConnections = 10
    private static readonly Encoding = 'utf8'
    private static readonly Schemes: ReadonlySet<string> = new Set(['postgres:', 'postgresql:'])
    private static readonly UnreadableMessage = 'the database URL file could not be read: '
    private static readonly EmptyMessage = 'the database URL file is empty: '
    private static readonly SchemeMessage = 'the database URL file does not hold a postgres:// URL: '
    private static readonly PoolSizeMessage = 'the pool size must be at least 1'

    public constructor(private readonly options: PostgresPoolOptions, private readonly createPool: (config: PoolConfig) => Pool = config => new pg.Pool(config))
    {
        if (options.MaxConnections !== undefined && !(options.MaxConnections >= 1))
        {
            throw new Error(PostgresPoolFactory.PoolSizeMessage)
        }
    }

    public async Create(): Promise<Pool>
    {
        const url = await this.ReadUrl()
        const config: PoolConfig = {
            ...parseIntoClientConfig(url),
            max: this.options.MaxConnections ?? PostgresPoolFactory.DefaultMaxConnections,
        }
        if (this.options.ApplicationName !== undefined)
        {
            config.application_name = this.options.ApplicationName
        }
        return this.createPool(config)
    }

    private async ReadUrl(): Promise<string>
    {
        let text: string
        try
        {
            text = await readFile(this.options.UrlFile, PostgresPoolFactory.Encoding)
        }
        catch
        {
            throw new Error(PostgresPoolFactory.UnreadableMessage + this.options.UrlFile)
        }
        const url = text.trim()
        if (url === '')
        {
            throw new Error(PostgresPoolFactory.EmptyMessage + this.options.UrlFile)
        }
        if (!PostgresPoolFactory.Schemes.has(PostgresPoolFactory.Scheme(url)))
        {
            throw new Error(PostgresPoolFactory.SchemeMessage + this.options.UrlFile)
        }
        return url
    }

    private static Scheme(url: string): string
    {
        try
        {
            return new URL(url).protocol
        }
        catch
        {
            return ''
        }
    }
}
