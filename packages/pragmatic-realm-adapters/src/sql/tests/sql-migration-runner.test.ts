import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlMigration, SqlMigrationModule } from '../sql-migration.js'
import { SqlMigrationRunner } from '../sql-migration-runner.js'
import { SqlMigrationChecksumError, SqlMigrationDefinitionError, SqlMigrationDowngradeError, SqlMigrationTransactionRequiredError } from '../sql-migration-errors.js'

class ProbeModule extends SqlMigrationModule
{
    public constructor(public readonly Name: string, private readonly steps: readonly SqlMigration[])
    {
        super()
    }

    public Migrations(): readonly SqlMigration[]
    {
        return this.steps
    }
}

class ProbeSteps
{
    public static CreateA = new SqlMigration(1, ['CREATE TABLE probe_a (id text PRIMARY KEY)'])
    public static AddColumn = new SqlMigration(2, ['ALTER TABLE probe_a ADD COLUMN n integer'])
    public static CreateB = new SqlMigration(3, ['CREATE TABLE probe_b (id text PRIMARY KEY)', 'INSERT INTO probe_b (id) VALUES (\'seed\')'])

    public static Recorded(session: ISqlSession, module: string): Promise<readonly SqlRow[]>
    {
        return session.Query('SELECT module, version, checksum, applied_at FROM schema_migrations WHERE module = $1 ORDER BY version', [module])
    }
}

/** A session without Transaction (e.g. a REST-backed ISqlSession). */
class NoTransactionSession implements ISqlSession
{
    public async Query(): Promise<readonly SqlRow[]>
    {
        return []
    }

    public async Execute(): Promise<number>
    {
        return 0
    }
}

test('a migration checksum is the sha256 of its statements, each terminated by ";\\n"', () =>
{
    const expected = createHash('sha256').update('CREATE TABLE x (id text);\nINSERT INTO x VALUES (1);\n').digest('hex')
    assert.equal(new SqlMigration(1, ['CREATE TABLE x (id text)', 'INSERT INTO x VALUES (1)']).Checksum, expected)
})

test('a session without Transaction is refused', async () =>
{
    await assert.rejects(() => new SqlMigrationRunner(new NoTransactionSession()).Apply(new ProbeModule('m', [ProbeSteps.CreateA])), SqlMigrationTransactionRequiredError)
})

test('versions must run 1..n without gaps or repeats, and a module needs a name', () =>
{
    for (const steps of [[ProbeSteps.AddColumn], [ProbeSteps.CreateA, ProbeSteps.CreateB], [ProbeSteps.CreateA, ProbeSteps.CreateA], []])
    {
        assert.throws(() => SqlMigrationRunner.Validate(new ProbeModule('m', steps)), SqlMigrationDefinitionError)
    }
    assert.throws(() => SqlMigrationRunner.Validate(new ProbeModule('', [ProbeSteps.CreateA])), SqlMigrationDefinitionError)
})

SqlTestSessions.Describe('SqlMigrationRunner', (makeSession, backend) =>
{
    test(`${backend}: applies every step in order and records module, version, checksum and time`, async () =>
    {
        const session = await makeSession()
        const applied = await new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA, ProbeSteps.AddColumn, ProbeSteps.CreateB]))
        assert.deepEqual(applied, [1, 2, 3])
        await session.Execute('INSERT INTO probe_a (id, n) VALUES ($1, $2)', ['x', 1])
        assert.equal((await session.Query('SELECT id FROM probe_b', [])).length, 1)
        const recorded = await ProbeSteps.Recorded(session, 'probe')
        assert.deepEqual(recorded.map(r => [Number(r.version), r.checksum]), [[1, ProbeSteps.CreateA.Checksum], [2, ProbeSteps.AddColumn.Checksum], [3, ProbeSteps.CreateB.Checksum]])
        assert.ok(recorded.every(r => r.applied_at !== null && r.applied_at !== undefined))
    })

    test(`${backend}: a second run applies nothing`, async () =>
    {
        const session = await makeSession()
        const module = new ProbeModule('probe', [ProbeSteps.CreateA, ProbeSteps.AddColumn, ProbeSteps.CreateB])
        await new SqlMigrationRunner(session).Apply(module)
        assert.deepEqual(await new SqlMigrationRunner(session).Apply(module), [])
        assert.equal((await session.Query('SELECT id FROM probe_b', [])).length, 1)
    })

    test(`${backend}: a later step added to the code applies alone`, async () =>
    {
        const session = await makeSession()
        await new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA]))
        assert.deepEqual(await new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA, ProbeSteps.AddColumn])), [2])
    })

    test(`${backend}: modules are versioned independently`, async () =>
    {
        const session = await makeSession()
        await new SqlMigrationRunner(session).Apply(new ProbeModule('one', [ProbeSteps.CreateA]))
        assert.deepEqual(await new SqlMigrationRunner(session).Apply(new ProbeModule('two', [new SqlMigration(1, ['CREATE TABLE probe_two (id text)'])])), [1])
        assert.equal((await ProbeSteps.Recorded(session, 'one')).length, 1)
        assert.equal((await ProbeSteps.Recorded(session, 'two')).length, 1)
    })

    test(`${backend}: a changed applied migration is refused`, async () =>
    {
        const session = await makeSession()
        await new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA]))
        const edited = new SqlMigration(1, ['CREATE TABLE probe_a (id text PRIMARY KEY, extra text)'])
        await assert.rejects(() => new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [edited, ProbeSteps.AddColumn])), (err: unknown) =>
            err instanceof SqlMigrationChecksumError && err.Module === 'probe' && err.Version === 1)
        assert.equal((await ProbeSteps.Recorded(session, 'probe')).length, 1)
    })

    test(`${backend}: an applied version the code does not know (a downgrade) is refused`, async () =>
    {
        const session = await makeSession()
        await new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA, ProbeSteps.AddColumn]))
        await assert.rejects(() => new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA])), (err: unknown) =>
            err instanceof SqlMigrationDowngradeError && err.Module === 'probe' && err.AppliedVersion === 2 && err.KnownVersion === 1)
    })

    test(`${backend}: a failing step stops the run; earlier steps stay applied, the failed one is not recorded`, async () =>
    {
        const session = await makeSession()
        const broken = new SqlMigration(2, ['CREATE TABLE probe_c (id text)', 'THIS IS NOT SQL'])
        await assert.rejects(() => new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [ProbeSteps.CreateA, broken])))
        assert.deepEqual((await ProbeSteps.Recorded(session, 'probe')).map(r => Number(r.version)), [1])
    })
})

SqlTestSessions.DescribeLive('SqlMigrationRunner', makeDatabase =>
{
    test('SqlMigrationRunner [live]: a failing step is rolled back as a whole', async () =>
    {
        const database = await makeDatabase()
        const session = database.Session()
        const broken = new SqlMigration(1, ['CREATE TABLE probe_c (id text)', 'THIS IS NOT SQL'])
        await assert.rejects(() => new SqlMigrationRunner(session).Apply(new ProbeModule('probe', [broken])))
        await assert.rejects(() => session.Query('SELECT id FROM probe_c', []), /probe_c/)
        await database.Dispose()
    })

    test('SqlMigrationRunner [live]: concurrent starters apply each step exactly once', async () =>
    {
        const database = await makeDatabase()
        const counted = [
            new SqlMigration(1, ['CREATE TABLE probe_runs (step integer NOT NULL)', 'INSERT INTO probe_runs (step) VALUES (1)']),
            new SqlMigration(2, ['INSERT INTO probe_runs (step) VALUES (2)', 'SELECT pg_sleep(0.05)']),
            new SqlMigration(3, ['INSERT INTO probe_runs (step) VALUES (3)']),
        ]
        const starters = Array.from({ length: 6 }, () => new SqlMigrationRunner(database.Session()).Apply(new ProbeModule('probe', counted)))
        const results = await Promise.all(starters)
        assert.deepEqual(results.flat().sort(), [1, 2, 3])
        const runs = await database.Session().Query('SELECT step FROM probe_runs ORDER BY step', [])
        assert.deepEqual(runs.map(r => Number(r.step)), [1, 2, 3])
        await database.Dispose()
    })
})
