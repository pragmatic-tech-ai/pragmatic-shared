import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Pool, PoolConfig } from 'pg'
import { PostgresPoolFactory } from '../postgres-pool-factory.js'

class UrlFile
{
    public static readonly Password = 's3cr3t-pw-a1b2'

    public static async With(content: string, body: (path: string, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'pg-pool-factory-'))
        try
        {
            const path = join(dir, 'database-url')
            await writeFile(path, content)
            await body(path, dir)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

class CapturingPool
{
    public static Last: PoolConfig | undefined
    public static LastPool: EventEmitter | undefined

    public static readonly Create = (config: PoolConfig): Pool =>
    {
        CapturingPool.Last = config
        const pool = Object.assign(new EventEmitter(), { end: async () => undefined })
        CapturingPool.LastPool = pool
        return pool as unknown as Pool
    }
}

class PgError extends Error
{
    public constructor(message: string, public readonly code: string)
    {
        super(message)
    }
}

test('reads the URL from the secret file (trailing newline trimmed) and sizes the pool from the options', async () =>
{
    await UrlFile.With(`postgres://app:${UrlFile.Password}@db.internal:5433/appdb\n`, async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path, MaxConnections: 4, ApplicationName: 'platform-admin' }, CapturingPool.Create).Create()
        const config = CapturingPool.Last!
        assert.equal(config.host, 'db.internal')
        assert.equal(Number(config.port), 5433)
        assert.equal(config.user, 'app')
        assert.equal(config.password, UrlFile.Password)
        assert.equal(config.database, 'appdb')
        assert.equal(config.max, 4)
        assert.equal(config.application_name, 'platform-admin')
        assert.ok(!config.ssl)
    })
})

test('Database opens another database of the server as the URL role', async () =>
{
    await UrlFile.With(`postgres://postgres:${UrlFile.Password}@db.internal:5432/postgres`, async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path, Database: 'realm_secrets' }, CapturingPool.Create).Create()
        assert.equal(CapturingPool.Last!.database, 'realm_secrets')
        assert.equal(CapturingPool.Last!.user, 'postgres')
    })
})

test('the pool size defaults to 10', async () =>
{
    await UrlFile.With('postgresql://app:pw@db/appdb', async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create()
        assert.equal(CapturingPool.Last!.max, 10)
    })
})

test('TLS comes from the URL: sslmode=require turns it on, sslmode=disable keeps it off', async () =>
{
    await UrlFile.With('postgres://app:pw@db/appdb?sslmode=require', async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create()
        assert.ok(CapturingPool.Last!.ssl)
    })
    await UrlFile.With('postgres://app:pw@db/appdb?sslmode=disable', async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create()
        assert.ok(!CapturingPool.Last!.ssl)
    })
})

test('a private CA comes from sslrootcert (a file path in the URL)', async () =>
{
    await UrlFile.With('', async (_path, dir) =>
    {
        const ca = join(dir, 'ca.pem')
        await writeFile(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
        const urlPath = join(dir, 'url')
        await writeFile(urlPath, `postgres://app:pw@db/appdb?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`)
        await new PostgresPoolFactory({ UrlFile: urlPath }, CapturingPool.Create).Create()
        const ssl = CapturingPool.Last!.ssl as { ca?: string }
        assert.match(String(ssl.ca), /BEGIN CERTIFICATE/)
    })
})

test('a missing, empty or non-postgres secret file is refused without echoing its content', async () =>
{
    await assert.rejects(() => new PostgresPoolFactory({ UrlFile: join(tmpdir(), 'definitely-missing-url-file') }, CapturingPool.Create).Create(), /database URL file/)
    await UrlFile.With('  \n', async path =>
    {
        await assert.rejects(() => new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create(), /empty/)
    })
    await UrlFile.With(`mysql://app:${UrlFile.Password}@db/appdb`, async path =>
    {
        await assert.rejects(() => new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create(), (err: unknown) =>
            err instanceof Error && /postgres/.test(err.message) && !err.message.includes(UrlFile.Password))
    })
})

test('the pool has an error listener: an idle client error goes to OnIdleError instead of crashing the process', async () =>
{
    await UrlFile.With(`postgres://app:${UrlFile.Password}@db/appdb`, async path =>
    {
        const seen: Error[] = []
        await new PostgresPoolFactory({ UrlFile: path, OnIdleError: error => seen.push(error) }, CapturingPool.Create).Create()
        const pool = CapturingPool.LastPool!
        assert.equal(pool.listenerCount('error'), 1)
        const failure = new PgError('terminating connection due to administrator command', '57P01')
        assert.doesNotThrow(() => pool.emit('error', failure))
        assert.deepEqual(seen, [failure])
    })
})

test('by default an idle client error writes only its class and code to stderr (no message, no URL)', async () =>
{
    await UrlFile.With(`postgres://app:${UrlFile.Password}@db.internal/appdb`, async path =>
    {
        await new PostgresPoolFactory({ UrlFile: path }, CapturingPool.Create).Create()
        const written: string[] = []
        const original = process.stderr.write
        process.stderr.write = ((chunk: string | Uint8Array) =>
        {
            written.push(String(chunk))
            return true
        }) as typeof process.stderr.write
        try
        {
            CapturingPool.LastPool!.emit('error', new PgError(`connect to postgres://app:${UrlFile.Password}@db.internal failed`, 'ECONNRESET'))
        }
        finally
        {
            process.stderr.write = original
        }
        assert.equal(written.length, 1)
        assert.match(written[0]!, /PgError ECONNRESET\n$/)
        assert.ok(!written[0]!.includes(UrlFile.Password))
        assert.ok(!written[0]!.includes('db.internal'))
    })
    assert.equal(PostgresPoolFactory.DescribeIdleError(new Error('x')), 'postgres pool: an idle client failed: Error')
})

test('a real pg.Pool gets the listener too', async () =>
{
    await UrlFile.With('postgres://app:pw@127.0.0.1:1/appdb', async path =>
    {
        const seen: Error[] = []
        const pool = await new PostgresPoolFactory({ UrlFile: path, OnIdleError: error => seen.push(error) }).Create()
        try
        {
            assert.equal(pool.listenerCount('error'), 1)
            pool.emit('error', new Error('idle'))
            assert.equal(seen.length, 1)
        }
        finally
        {
            await pool.end()
        }
    })
})

test('a pool size below 1 is refused', () =>
{
    assert.throws(() => new PostgresPoolFactory({ UrlFile: 'x', MaxConnections: 0 }), /pool size/)
})

test('without an injected pool creator, Create loads pg then and answers a pg.Pool (no connection is opened)', async () =>
{
    await UrlFile.With('postgres://app:pw@127.0.0.1:1/appdb', async path =>
    {
        const pool = await new PostgresPoolFactory({ UrlFile: path, MaxConnections: 3 }).Create()
        try
        {
            const pg = await import('pg')
            assert.ok(pool instanceof pg.default.Pool)
            assert.equal(pool.options.max, 3)
        }
        finally
        {
            await pool.end()
        }
    })
})

class LiveDatabase
{
    public static readonly Url = process.env.PRAGMATIC_TEST_PG_URL ?? ''
}

test('[live] a pool from the URL file reaches the database', { skip: LiveDatabase.Url === '' }, async () =>
{
    await UrlFile.With(LiveDatabase.Url, async path =>
    {
        const pool = await new PostgresPoolFactory({ UrlFile: path, MaxConnections: 2 }).Create()
        try
        {
            const result = await pool.query('SELECT 1 AS one')
            assert.equal(result.rows[0].one, 1)
        }
        finally
        {
            await pool.end()
        }
    })
})
