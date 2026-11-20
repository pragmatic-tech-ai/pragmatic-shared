import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import type { SqlMigration, SqlMigrationModule } from './sql-migration.js'
import { SqlMigrationChecksumError, SqlMigrationDefinitionError, SqlMigrationDowngradeError, SqlMigrationTransactionRequiredError } from './sql-migration-errors.js'

/** Applies a store module's migrations at start. Applied steps are recorded in `schema_migrations` (module, version,
 *  checksum, applied_at). Every step runs in its own transaction that first takes one database-wide transaction-scoped
 *  advisory lock, re-reads the module's applied versions under it and only then runs the step's statements and records
 *  it; so concurrent starters (several replicas, several stores of one process) serialize and each step runs exactly
 *  once. Before anything runs, the recorded history is checked against the code: an applied step whose checksum
 *  differs (edited after it ran) or an applied version the code does not know (older code on a newer schema) refuses
 *  the start. The bookkeeping table itself is created with IF NOT EXISTS, under the same lock. */
export class SqlMigrationRunner
{
    /** Shared by every module: one lock for the whole database (ASCII "PRAGMIGR"). */
    private static readonly LockKey = '5787662337017744210'
    private static readonly LockSql = 'SELECT pg_advisory_xact_lock($1)'
    private static readonly TableSql = 'CREATE TABLE IF NOT EXISTS schema_migrations (module text NOT NULL, version integer NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL, PRIMARY KEY (module, version))'
    private static readonly AppliedSql = 'SELECT version, checksum FROM schema_migrations WHERE module = $1 ORDER BY version'
    private static readonly RecordSql = 'INSERT INTO schema_migrations (module, version, checksum, applied_at) VALUES ($1, $2, $3, now())'
    private static readonly NoNameReason = 'a module needs a name'
    private static readonly NoStepsReason = 'a module needs at least one migration'
    private static readonly SequenceReason = 'migration versions must be exactly 1..n in order'

    private readonly session: ISqlSession
    private bootstrapped = false

    public constructor(session: ISqlSession)
    {
        this.session = session
    }

    /** Runs `module`'s pending migrations; returns the versions this call applied (empty when up to date). */
    public static Run(session: ISqlSession, module: SqlMigrationModule): Promise<readonly number[]>
    {
        return new SqlMigrationRunner(session).Apply(module)
    }

    /** Throws SqlMigrationDefinitionError unless the module has a name and versions exactly 1..n in order. */
    public static Validate(module: SqlMigrationModule): readonly SqlMigration[]
    {
        if (module.Name === '')
        {
            throw new SqlMigrationDefinitionError(module.Name, SqlMigrationRunner.NoNameReason)
        }
        const migrations = module.Migrations()
        if (migrations.length === 0)
        {
            throw new SqlMigrationDefinitionError(module.Name, SqlMigrationRunner.NoStepsReason)
        }
        migrations.forEach((migration, index) =>
        {
            if (migration.Version !== index + 1)
            {
                throw new SqlMigrationDefinitionError(module.Name, SqlMigrationRunner.SequenceReason)
            }
        })
        return migrations
    }

    public async Apply(module: SqlMigrationModule): Promise<readonly number[]>
    {
        const migrations = SqlMigrationRunner.Validate(module)
        await this.Bootstrap(module)
        const pending = await this.Locked(async tx => SqlMigrationRunner.Pending(module, migrations, await tx.Query(SqlMigrationRunner.AppliedSql, [module.Name])))
        const applied: number[] = []
        for (const migration of pending)
        {
            if (await this.ApplyOne(module, migrations, migration))
            {
                applied.push(migration.Version)
            }
        }
        return applied
    }

    /** One transaction: lock, re-check the history (a concurrent starter may have applied it), run, record. */
    private ApplyOne(module: SqlMigrationModule, migrations: readonly SqlMigration[], migration: SqlMigration): Promise<boolean>
    {
        return this.Locked(async tx =>
        {
            const pending = SqlMigrationRunner.Pending(module, migrations, await tx.Query(SqlMigrationRunner.AppliedSql, [module.Name]))
            if (!pending.includes(migration))
            {
                return false
            }
            for (const statement of migration.Statements)
            {
                await tx.Execute(statement, [])
            }
            await tx.Execute(SqlMigrationRunner.RecordSql, [module.Name, migration.Version, migration.Checksum])
            return true
        })
    }

    private async Bootstrap(module: SqlMigrationModule): Promise<void>
    {
        if (this.bootstrapped)
        {
            return
        }
        await this.Locked(async tx =>
        {
            await tx.Execute(SqlMigrationRunner.TableSql, [])
        }, module)
        this.bootstrapped = true
    }

    private Locked<T>(work: (tx: ISqlSession) => Promise<T>, module?: SqlMigrationModule): Promise<T>
    {
        if (this.session.Transaction === undefined)
        {
            throw new SqlMigrationTransactionRequiredError(module?.Name ?? '')
        }
        return this.session.Transaction(async tx =>
        {
            await tx.Query(SqlMigrationRunner.LockSql, [SqlMigrationRunner.LockKey])
            return work(tx)
        })
    }

    /** Checks the recorded history against the code and returns the migrations not yet applied, in order. */
    private static Pending(module: SqlMigrationModule, migrations: readonly SqlMigration[], rows: readonly SqlRow[]): readonly SqlMigration[]
    {
        const applied = new Map<number, string>()
        for (const row of rows)
        {
            applied.set(Number(row.version), String(row.checksum))
        }
        for (const [version, checksum] of applied)
        {
            const known = migrations[version - 1]
            if (known === undefined)
            {
                throw new SqlMigrationDowngradeError(module.Name, Math.max(...applied.keys()), migrations.length)
            }
            if (known.Checksum !== checksum)
            {
                throw new SqlMigrationChecksumError(module.Name, version)
            }
        }
        return migrations.filter(migration => !applied.has(migration.Version))
    }
}
