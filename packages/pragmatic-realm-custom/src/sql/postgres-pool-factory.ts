import { readFile } from 'node:fs/promises'
import type { Pool, PoolConfig } from 'pg'

export interface PostgresPoolOptions
{
    /** Path of the secret file holding the database URL (`postgres://user:password@host:port/db?sslmode=...`). The URL
     *  is never taken from an environment variable value or the command line: it carries the password. */
    readonly UrlFile: string
    /** Pool size (default 10). */
    readonly MaxConnections?: number
    /** Reported to Postgres as application_name (pg_stat_activity). */
    readonly ApplicationName?: string
    /** Another database on the same server, as the URL's role (the hive Postgres superuser provisioning a database it made). */
    readonly Database?: string
    /** Called when an IDLE pooled client fails (Postgres restarted, the connection dropped). pg.Pool emits that as an
     *  'error' event, which would crash the process without a listener; the pool discards the client and reconnects
     *  on the next query. Default: one stderr line with the error's class and code only (never its message or the
     *  URL). */
    readonly OnIdleError?: (error: Error) => void
}

/** The custom realm option's Postgres: a pg.Pool for one application's database, from a database URL read from a
 *  secret file. TLS is the URL's business: `sslmode=require|verify-ca|verify-full` turns it on, `sslrootcert=<path>`
 *  names a private CA (with `sslcert`/`sslkey` for client certificates), `sslmode=disable` or no sslmode keeps a
 *  plain connection (the hive's own `pragmatic-postgres` on the pod network). Errors never echo the URL.
 *
 *  `pg` and `pg-connection-string` load on the first Create, never at import: the package root exports this factory,
 *  and a consumer with no database (the Plexus desktop app) imports the root without loading Postgres. */
export class PostgresPoolFactory
{
    private static readonly DefaultMaxConnections = 10
    private static readonly Encoding = 'utf8'
    private static readonly Schemes: ReadonlySet<string> = new Set(['postgres:', 'postgresql:'])
    private static readonly UnreadableMessage = 'the database URL file could not be read: '
    private static readonly EmptyMessage = 'the database URL file is empty: '
    private static readonly SchemeMessage = 'the database URL file does not hold a postgres:// URL: '
    private static readonly PoolSizeMessage = 'the pool size must be at least 1'
    private static readonly ErrorEvent = 'error'
    private static readonly IdleErrorPrefix = 'postgres pool: an idle client failed: '
    private static readonly CodeSeparator = ' '
    private static readonly LineEnd = '\n'

    public constructor(private readonly options: PostgresPoolOptions, private readonly createPool?: (config: PoolConfig) => Pool)
    {
        if (options.MaxConnections !== undefined && !(options.MaxConnections >= 1))
        {
            throw new Error(PostgresPoolFactory.PoolSizeMessage)
        }
    }

    public async Create(): Promise<Pool>
    {
        const url = await this.ReadUrl()
        const { parseIntoClientConfig } = await import('pg-connection-string')
        const config: PoolConfig = {
            ...parseIntoClientConfig(url),
            max: this.options.MaxConnections ?? PostgresPoolFactory.DefaultMaxConnections,
        }
        if (this.options.ApplicationName !== undefined)
        {
            config.application_name = this.options.ApplicationName
        }
        if (this.options.Database !== undefined)
        {
            config.database = this.options.Database
        }
        const pool = this.createPool !== undefined ? this.createPool(config) : new (await import('pg')).default.Pool(config)
        const onIdleError = this.options.OnIdleError ?? PostgresPoolFactory.ReportIdleError
        pool.on(PostgresPoolFactory.ErrorEvent, (error: Error) => onIdleError(error))
        return pool
    }

    /** The default idle-error report: the error's class and (pg/Node) code, nothing that could carry a secret. */
    public static ReportIdleError(error: Error): void
    {
        process.stderr.write(PostgresPoolFactory.DescribeIdleError(error) + PostgresPoolFactory.LineEnd)
    }

    public static DescribeIdleError(error: Error): string
    {
        const code = (error as { code?: unknown }).code
        const name = error?.constructor?.name ?? typeof error
        return PostgresPoolFactory.IdleErrorPrefix + name + (typeof code === 'string' || typeof code === 'number' ? PostgresPoolFactory.CodeSeparator + String(code) : '')
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
