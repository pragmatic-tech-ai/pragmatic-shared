import { setTimeout as delay } from 'node:timers/promises'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'

/** A record with the version it was read at (for PutIfVersion). */
export class SqlVersionedRecord<T>
{
    public constructor(public readonly Record: T, public readonly Version: number)
    {
    }
}

/** PutIfVersion found another version than the caller read (0 = the caller expected no record). */
export class SqlRecordVersionConflictError extends Error
{
    public constructor(public readonly Registry: string, public readonly Id: string, public readonly ExpectedVersion: number)
    {
        super(`record ${Registry}/${Id} is no longer at version ${ExpectedVersion}`)
        this.name = SqlRecordVersionConflictError.name
    }
}

/** Update lost the optimistic race on every attempt. */
export class SqlRecordUpdateContentionError extends Error
{
    public constructor(public readonly Registry: string, public readonly Id: string, public readonly Attempts: number)
    {
        super(`record ${Registry}/${Id} changed under every one of ${Attempts} update attempts`)
        this.name = SqlRecordUpdateContentionError.name
    }
}

export interface SqlRecordStoreOptions
{
    /** After each write, keep only the newest N records by last write (updated_at, then id); omitted: keep all.
     *  Domain-aware eviction (e.g. audit's anonymous-first policy) stays with the caller. */
    readonly RetainNewest?: number
    /** Attempts Update makes before SqlRecordUpdateContentionError (default 16). */
    readonly MaxUpdateAttempts?: number
    /** Clock stamping updated_at (default: the system clock). */
    readonly Now?: () => Date
}

/** The table of one registry: `records_<registry>` (id, document jsonb, version, updated_at). */
export class SqlRecordStoreMigrations extends SqlMigrationModule
{
    private static readonly ModulePrefix = 'records.'
    private static readonly TablePrefix = 'records_'

    public readonly Name: string
    public readonly Table: string

    public constructor(registry: string)
    {
        super()
        this.Name = SqlRecordStoreMigrations.ModulePrefix + registry
        this.Table = SqlRecordStoreMigrations.TablePrefix + registry
    }

    public Migrations(): readonly SqlMigration[]
    {
        return [
            new SqlMigration(1, [
                `CREATE TABLE ${this.Table} (id text PRIMARY KEY, document jsonb NOT NULL, version integer NOT NULL, updated_at timestamptz NOT NULL)`,
                `CREATE INDEX ${this.Table}_updated ON ${this.Table} (updated_at)`,
            ]),
        ]
    }
}

/** A registry of JSON documents keyed by `id`, one Postgres table per registry; the SQL counterpart of the control
 *  plane's JsonRecordStore (its whole-file JSON map). Every read returns a fresh copy; Put upserts and is durable
 *  when it resolves; Delete reports whether the record existed. Each row carries a version for optimistic
 *  concurrency: PutIfVersion writes only at the version the caller read (0 = must not exist), and Update(id, fn)
 *  re-runs fn on the latest record until its write lands. Documents are JSON values: fields that JSON drops
 *  (undefined, functions) do not round-trip, Dates come back as strings. */
export class SqlRecordStore<T extends { id: string }>
{
    private static readonly RegistryPattern = /^[a-z][a-z0-9_]{0,47}$/
    private static readonly BadRegistryMessage = 'a registry name must be a lower-case SQL identifier of at most 48 characters'
    private static readonly IdChangedMessage = 'Update must not change the record id'
    private static readonly DefaultMaxUpdateAttempts = 16
    private static readonly BackoffBaseMs = 2
    private static readonly BackoffMaxMs = 100
    private static readonly UniqueViolation = '23505'

    private readonly getSql: string
    private readonly listSql: string
    private readonly listPrefixSql: string
    private readonly upsertSql: string
    private readonly insertSql: string
    private readonly updateSql: string
    private readonly deleteSql: string
    private readonly deleteVersionSql: string
    private readonly retainSql: string
    private readonly now: () => Date
    private readonly maxUpdateAttempts: number

    private constructor(private readonly session: ISqlSession, private readonly registry: string, table: string, private readonly options: SqlRecordStoreOptions)
    {
        this.getSql = `SELECT document, version FROM ${table} WHERE id = $1`
        this.listSql = `SELECT document FROM ${table} ORDER BY id`
        this.listPrefixSql = `SELECT document FROM ${table} WHERE substring(id, 1, $2::integer) = $1 ORDER BY id`
        this.upsertSql = `INSERT INTO ${table} (id, document, version, updated_at) VALUES ($1, $2::jsonb, 1, $3) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, version = ${table}.version + 1, updated_at = EXCLUDED.updated_at RETURNING version`
        this.insertSql = `INSERT INTO ${table} (id, document, version, updated_at) SELECT $1, $2::jsonb, 1, $3::timestamptz WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE id = $1)`
        this.updateSql = `UPDATE ${table} SET document = $2::jsonb, version = version + 1, updated_at = $3 WHERE id = $1 AND version = $4`
        this.deleteSql = `DELETE FROM ${table} WHERE id = $1`
        this.deleteVersionSql = `DELETE FROM ${table} WHERE id = $1 AND version = $2`
        this.retainSql = `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY updated_at DESC, id DESC OFFSET $1)`
        this.now = options.Now ?? (() => new Date())
        this.maxUpdateAttempts = options.MaxUpdateAttempts ?? SqlRecordStore.DefaultMaxUpdateAttempts
    }

    /** Opens (and migrates) the table of `registry`, a lower-case identifier such as "hives" or "release_policies". */
    public static async Open<T extends { id: string }>(session: ISqlSession, registry: string, options: SqlRecordStoreOptions = {}): Promise<SqlRecordStore<T>>
    {
        if (!SqlRecordStore.RegistryPattern.test(registry))
        {
            throw new Error(SqlRecordStore.BadRegistryMessage)
        }
        const migrations = new SqlRecordStoreMigrations(registry)
        await SqlMigrationRunner.Run(session, migrations)
        return new SqlRecordStore<T>(session, registry, migrations.Table, options)
    }

    public async Get(id: string): Promise<T | undefined>
    {
        return (await this.GetVersioned(id))?.Record
    }

    public async GetVersioned(id: string): Promise<SqlVersionedRecord<T> | undefined>
    {
        const row = (await this.session.Query(this.getSql, [id]))[0]
        return row === undefined ? undefined : new SqlVersionedRecord(SqlRecordStore.Document<T>(row), Number(row.version))
    }

    public async List(): Promise<readonly T[]>
    {
        return (await this.session.Query(this.listSql, [])).map(row => SqlRecordStore.Document<T>(row))
    }

    /** Every record whose id starts with `prefix` (taken literally: `%`, `_` and `\` are not wildcards), ordered by
     *  id. An exact leading-substring comparison rather than LIKE: it needs no wildcard escaping and behaves the same
     *  on Postgres and pg-mem (which has no LIKE ... ESCAPE); a LIKE prefix scan would not use the id index under the
     *  databases' default (non-C) collation either. The length is in code points, as Postgres counts them. */
    public async ListPrefix(prefix: string): Promise<readonly T[]>
    {
        return (await this.session.Query(this.listPrefixSql, [prefix, [...prefix].length])).map(row => SqlRecordStore.Document<T>(row))
    }

    /** Inserts or replaces the record; returns its new version. */
    public async Put(record: T): Promise<number>
    {
        const rows = await this.session.Query(this.upsertSql, [record.id, JSON.stringify(record), this.now()])
        await this.Retain()
        return Number(rows[0]!.version)
    }

    /** Writes the record only if it is still at `expectedVersion` (0: only if absent); returns its new version. */
    public async PutIfVersion(record: T, expectedVersion: number): Promise<number>
    {
        if (!await this.TryWrite(record.id, record, expectedVersion))
        {
            throw new SqlRecordVersionConflictError(this.registry, record.id, expectedVersion)
        }
        await this.Retain()
        return expectedVersion + 1
    }

    public async Delete(id: string): Promise<boolean>
    {
        return await this.session.Execute(this.deleteSql, [id]) > 0
    }

    /** Reads the record (undefined when absent), lets `mutate` compute its successor (undefined: delete it) and
     *  writes that at the version read; on a concurrent change it waits a random, growing back-off (so contenders
     *  spread out instead of colliding again), re-reads and re-runs `mutate`. Returns what was written. */
    public async Update(id: string, mutate: (current: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined>
    {
        for (let attempt = 0; attempt < this.maxUpdateAttempts; attempt++)
        {
            const current = await this.GetVersioned(id)
            const next = await mutate(current?.Record)
            if (next !== undefined && next.id !== id)
            {
                throw new Error(SqlRecordStore.IdChangedMessage)
            }
            if (await this.TryWrite(id, next, current?.Version ?? 0))
            {
                await this.Retain()
                return next
            }
            await delay(Math.random() * Math.min(SqlRecordStore.BackoffMaxMs, SqlRecordStore.BackoffBaseMs * 2 ** attempt))
        }
        throw new SqlRecordUpdateContentionError(this.registry, id, this.maxUpdateAttempts)
    }

    /** One conditional write at `expectedVersion` (0 = absent); false when the row moved on. */
    private async TryWrite(id: string, next: T | undefined, expectedVersion: number): Promise<boolean>
    {
        if (next === undefined)
        {
            return expectedVersion === 0 || await this.session.Execute(this.deleteVersionSql, [id, expectedVersion]) > 0
        }
        if (expectedVersion === 0)
        {
            return await this.Insert(id, next)
        }
        return await this.session.Execute(this.updateSql, [id, JSON.stringify(next), this.now(), expectedVersion]) > 0
    }

    private async Insert(id: string, record: T): Promise<boolean>
    {
        try
        {
            return await this.session.Execute(this.insertSql, [id, JSON.stringify(record), this.now()]) > 0
        }
        catch (err)
        {
            // Insert-if-absent (not ON CONFLICT DO NOTHING, which pg-mem reports as affected); a concurrent insert of
            // the same id between the check and the write surfaces as a unique violation: the row exists, retry.
            if ((err as { code?: string }).code === SqlRecordStore.UniqueViolation)
            {
                return false
            }
            throw err
        }
    }

    private async Retain(): Promise<void>
    {
        if (this.options.RetainNewest !== undefined)
        {
            await this.session.Execute(this.retainSql, [this.options.RetainNewest])
        }
    }

    private static Document<T>(row: SqlRow): T
    {
        const document = row.document
        return (typeof document === 'string' ? JSON.parse(document) : structuredClone(document)) as T
    }
}
