import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession } from '../../sql/pg-session.js'
import { SqlMigrationRunner } from '../../sql/sql-migration-runner.js'
import { SqlSecretKeyRing, SqlSecretMigrations, SqlSecretStore } from '../../secrets/sql-secret-store.js'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { CustomRealmSecrets, UnversionedSecretsHomeError } from '../custom-realm-secrets.js'
import { RealmSecretsHome } from '../realm-secrets-home.js'
import { RealmSecretsGrant, RealmSecretsProvisioning } from '../realm-secrets-provisioning.js'
import { RealmSecretsOption } from '../realm-secrets-option.js'
import { RealmSecretsSettings } from '../realm-secrets-settings.js'
import { SecretsHomeFailure, SecretsHomeUnavailableError } from '../secrets-home-unavailable-error.js'
import { WorkloadContext } from '../workload-context.js'

class Failure
{
    public static Is(code: SecretsHomeFailure): (error: unknown) => boolean
    {
        return error => error instanceof SecretsHomeUnavailableError && error.Option === RealmSecretsOption.Custom && error.Code === code
    }
}

SqlTestSessions.Describe('CustomRealmSecretStore', (makeSession, backend) =>
{
    const migrated = async (): Promise<ISqlSession> =>
    {
        const session = await makeSession()
        await SqlMigrationRunner.Run(session, new SqlSecretMigrations())
        return session
    }

    test(`${backend}: the writer writes, a reader of the realm reads, names stay one segment`, async () =>
    {
        const session = await migrated()
        const key = randomBytes(32)
        const writer = CustomRealmSecrets.Over(session, key, 'acme', true)
        await writer.Put('google-client-secret', 'v1')
        const reader = CustomRealmSecrets.Over(session, key, 'acme', false)
        assert.equal(await reader.Get('google-client-secret'), 'v1')
        assert.equal(await reader.Get('absent'), null)
        assert.equal(await reader.Get('.key-check'), null, 'the key check row is never a secret')
        await assert.rejects(writer.Put('a/b', 'x'), /one segment/)
        await writer.Delete('google-client-secret')
        assert.equal(await reader.Get('google-client-secret'), null)
    })

    test(`${backend}: a reader cannot write`, async () =>
    {
        const session = await migrated()
        const reader = CustomRealmSecrets.Over(session, randomBytes(32), 'acme', false)
        await assert.rejects(reader.Put('x', 'y'), Failure.Is(SecretsHomeFailure.PermissionDenied))
        await assert.rejects(reader.Delete('x'), Failure.Is(SecretsHomeFailure.PermissionDenied))
    })

    test(`${backend}: realms are scoped: realm B's store never sees realm A's rows`, async () =>
    {
        const session = await migrated()
        const key = randomBytes(32)
        await CustomRealmSecrets.Over(session, key, 'realm-a', true).Put('probe', 'a-value')
        const b = CustomRealmSecrets.Over(session, key, 'realm-b', true)
        assert.equal(await b.Get('probe'), null)
    })

    test(`${backend}: a replaced master key is refused, for the writer and every reader`, async () =>
    {
        const session = await migrated()
        await CustomRealmSecrets.Over(session, randomBytes(32), 'acme', true).Put('probe', 'v')
        const wrong = randomBytes(32)
        await assert.rejects(CustomRealmSecrets.Over(session, wrong, 'acme', true).Verify(), Failure.Is(SecretsHomeFailure.KeyMismatch))
        await assert.rejects(CustomRealmSecrets.Over(session, wrong, 'acme', false).Get('probe'), Failure.Is(SecretsHomeFailure.KeyMismatch))
        await assert.rejects(CustomRealmSecrets.Over(session, wrong, 'acme', true).Put('other', 'v'), Failure.Is(SecretsHomeFailure.KeyMismatch))
    })

    test(`${backend}: rows without a key check row must open before the writer adopts the mounted key`, async () =>
    {
        const session = await migrated()
        const original = randomBytes(32)
        // Rows sealed before any key check (an import, a restore that lost the check row).
        await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('realm-master', original), 'realm/acme').then(store => store.Put('probe', 'v'))
        const replaced = randomBytes(32)
        await assert.rejects(CustomRealmSecrets.Over(session, replaced, 'acme', true).Verify(), Failure.Is(SecretsHomeFailure.KeyMismatch))
        await assert.rejects(CustomRealmSecrets.Over(session, replaced, 'acme', false).Get('probe'), Failure.Is(SecretsHomeFailure.KeyMismatch))
        // The replaced key was not adopted: the original still opens, and the writer then writes the check row.
        await CustomRealmSecrets.Over(session, original, 'acme', true).Verify()
        await assert.rejects(CustomRealmSecrets.Over(session, replaced, 'acme', true).Verify(), Failure.Is(SecretsHomeFailure.KeyMismatch))
        assert.equal(await CustomRealmSecrets.Over(session, original, 'acme', false).Get('probe'), 'v')
    })

    test(`${backend}: a pinned version is refused as such`, async () =>
    {
        const session = await migrated()
        await assert.rejects(CustomRealmSecrets.Over(session, randomBytes(32), 'acme', false).Get('probe@2'), (error: Error) => error instanceof UnversionedSecretsHomeError && (error as UnversionedSecretsHomeError).code === 'unversioned')
    })

    test(`${backend}: a database without the schema is not-found, never the driver's text`, async () =>
    {
        const session = await makeSession()
        await assert.rejects(CustomRealmSecrets.Over(session, randomBytes(32), 'acme', false).Get('probe'), (error: Error) =>
        {
            assert.ok(error instanceof SecretsHomeUnavailableError)
            assert.ok([SecretsHomeFailure.NotFound, SecretsHomeFailure.Unreachable].includes(error.Code))
            assert.doesNotMatch(error.message, /sealed_secrets|relation/)
            return true
        })
    })
})

test('the custom factory reads its URL and key files; an unreadable key or database is typed', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'custom-home-'))
    try
    {
        const keyFile = join(dir, 'master-key')
        const urlFile = join(dir, 'database-url')
        const home = new RealmSecretsHome([new CustomRealmSecrets()])
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Custom, { databaseUrlFile: urlFile, masterKeyFile: keyFile, access: 'reader' })
        const store = await home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-idp'))
        await assert.rejects(store.Get('probe'), Failure.Is(SecretsHomeFailure.KeyUnreadable), 'a missing key file')
        await writeFile(keyFile, randomBytes(16))
        await assert.rejects(store.Get('probe'), Failure.Is(SecretsHomeFailure.KeyUnreadable), 'a key of the wrong length')
        await writeFile(keyFile, randomBytes(32).toString('base64') + '\n')
        await assert.rejects(store.Get('probe'), Failure.Is(SecretsHomeFailure.Unreachable))
        await writeFile(urlFile, 'postgres://nobody:nothing@127.0.0.1:1/realm_secrets\n')
        await assert.rejects(store.Get('probe'), Failure.Is(SecretsHomeFailure.Unreachable))
        assert.equal((await CustomRealmSecrets.ReadKeys(keyFile)).Current.length, 32)
        assert.throws(() => RealmSecretsSettings.Of(RealmSecretsOption.Custom, { databaseUrlFile: 'relative', masterKeyFile: keyFile }).Validated(new CustomRealmSecrets().Settings), /DATABASE_URL_FILE does not have the form of an absolute file path/)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})

// Live only: roles, grants and row-level security (pg-mem has none of them). Creating roles needs a role that may
// (PRAGMATIC_TEST_PG_ADMIN_URL: the test Postgres's superuser on the hive laptop); the test role itself may not.
const adminUrl = process.env.PRAGMATIC_TEST_PG_ADMIN_URL ?? ''
SqlTestSessions.DescribeLive('realm secrets provisioning', makeDatabase =>
{
    if (adminUrl === '') return

    class Roles
    {
        public readonly Names: string[] = []

        public readonly Admin: PgSession

        public constructor(private readonly schema: string, private readonly url: string)
        {
            this.Admin = new PgSession(new Pool({ connectionString: adminUrl, options: `-c search_path=${schema}`, max: 2, allowExitOnIdle: true }))
        }

        public async Create(suffix: string): Promise<string>
        {
            const name = `${this.schema}_${suffix}`
            await this.Admin.Execute(`CREATE ROLE "${name}" LOGIN PASSWORD 'p-${name}'`, [])
            this.Names.push(name)
            return name
        }

        public Session(role: string): PgSession
        {
            const url = new URL(this.url)
            url.username = role
            url.password = `p-${role}`
            return new PgSession(new Pool({ connectionString: url.toString(), options: `-c search_path=${this.schema}`, max: 2, allowExitOnIdle: true }))
        }

        public async Drop(): Promise<void>
        {
            for (const name of this.Names)
            {
                await this.Admin.Execute(`DROP OWNED BY "${name}"`, [])
                await this.Admin.Execute(`DROP ROLE "${name}"`, [])
            }
            await this.Admin.Dispose()
        }
    }

    test('[live] privileges follow every grant row: a writer elsewhere keeps writing; a role losing its last grant loses them', async () =>
    {
        const database = await makeDatabase()
        const roles = new Roles(database.Schema, process.env.PRAGMATIC_TEST_PG_URL!)
        const sessions: PgSession[] = []
        try
        {
            const both = await roles.Create('both')
            const consoleY = await roles.Create('console_y')
            const gone = await roles.Create('gone')
            await RealmSecretsProvisioning.Run(roles.Admin, [new RealmSecretsGrant('realm-x', [both], [gone])])
            // A later run for realm Y only, where `both` reads: it still writes in X.
            await RealmSecretsProvisioning.Run(roles.Admin, [new RealmSecretsGrant('realm-y', [consoleY], [both])])
            const key = randomBytes(32)
            const asBoth = roles.Session(both)
            const asGone = roles.Session(gone)
            sessions.push(asBoth, asGone)
            await CustomRealmSecrets.Over(asBoth, key, 'realm-x', true, true).Put('probe', 'x-value')
            await assert.rejects(CustomRealmSecrets.Over(asBoth, key, 'realm-y', true, true).Put('probe', 'forged'), Failure.Is(SecretsHomeFailure.PermissionDenied))
            assert.equal(await CustomRealmSecrets.Over(asGone, key, 'realm-x', false, true).Get('probe'), 'x-value')
            // Realm X's grants change: `gone` is no reader any more, so it loses its privileges.
            await RealmSecretsProvisioning.Run(roles.Admin, [new RealmSecretsGrant('realm-x', [both], [])])
            await assert.rejects(asGone.Query('SELECT reference FROM sealed_secrets', []), (error: { code?: string }) => error.code === '42501')
            assert.equal(await CustomRealmSecrets.Over(asBoth, key, 'realm-x', false, true).Get('probe'), 'x-value')
        }
        finally
        {
            for (const session of sessions) await session.Dispose()
            await roles.Drop()
            await database.Dispose()
        }
    })

    test('[live] two roles: the reader cannot write, realm B\'s rows are invisible to realm A\'s roles', async () =>
    {
        const database = await makeDatabase()
        const roles = new Roles(database.Schema, process.env.PRAGMATIC_TEST_PG_URL!)
        const admin = roles.Admin
        const sessions: PgSession[] = []
        try
        {
            const writerA = await roles.Create('console_a')
            const readerA = await roles.Create('idp_a')
            const writerB = await roles.Create('console_b')
            await RealmSecretsProvisioning.Run(admin, [new RealmSecretsGrant('realm-a', [writerA], [readerA]), new RealmSecretsGrant('realm-b', [writerB], [])])
            // Converges: running it again changes nothing.
            await RealmSecretsProvisioning.Run(admin, [new RealmSecretsGrant('realm-a', [writerA], [readerA]), new RealmSecretsGrant('realm-b', [writerB], [])])
            const key = randomBytes(32)
            const asWriterA = roles.Session(writerA)
            const asReaderA = roles.Session(readerA)
            const asWriterB = roles.Session(writerB)
            sessions.push(asWriterA, asReaderA, asWriterB)

            await CustomRealmSecrets.Over(asWriterA, key, 'realm-a', true).Put('probe', 'a-value')
            await CustomRealmSecrets.Over(asWriterB, key, 'realm-b', true).Put('probe', 'b-value')
            assert.equal(await CustomRealmSecrets.Over(asReaderA, key, 'realm-a', false).Get('probe'), 'a-value')

            // The database refuses the reader's write even when the store is told it writes.
            await assert.rejects(CustomRealmSecrets.Over(asReaderA, key, 'realm-a', true).Put('probe', 'forged'), Failure.Is(SecretsHomeFailure.PermissionDenied))
            assert.equal(await CustomRealmSecrets.Over(asReaderA, key, 'realm-a', false).Get('probe'), 'a-value')

            // Realm A's roles see none of realm B's rows, even naming realm B's scope.
            assert.equal(await CustomRealmSecrets.Over(asReaderA, key, 'realm-b', false).Get('probe'), null)
            assert.equal(await CustomRealmSecrets.Over(asWriterA, key, 'realm-b', false).Get('probe'), null)
            assert.deepEqual(await asReaderA.Query("SELECT scope FROM sealed_secrets WHERE scope = 'realm/realm-b'", []), [])
            // ... and cannot write into it.
            await assert.rejects(CustomRealmSecrets.Over(asWriterA, key, 'realm-b', true).Put('probe', 'forged'), Failure.Is(SecretsHomeFailure.PermissionDenied))
            assert.equal(await CustomRealmSecrets.Over(asWriterB, key, 'realm-b', false).Get('probe'), 'b-value')
            // A role cannot grant itself another realm, and sees only its own grant rows.
            await assert.rejects(asWriterA.Execute("INSERT INTO realm_secret_grants (role_name, realm_id, writer) VALUES (current_user, 'realm-b', true)", []), (error: { code?: string }) => error.code === '42501')
            assert.deepEqual((await asReaderA.Query('SELECT role_name, realm_id FROM realm_secret_grants', [])).map(row => [row.role_name, row.realm_id]), [[readerA, 'realm-a']])
            // Opened as the factory opens it, a store checks its role's grant first: realm B is permission-denied for A's
            // reader instead of every secret reading absent.
            await assert.rejects(CustomRealmSecrets.Over(asReaderA, key, 'realm-b', false, true).Get('probe'), Failure.Is(SecretsHomeFailure.PermissionDenied))
            assert.equal(await CustomRealmSecrets.Over(asReaderA, key, 'realm-a', false, true).Get('probe'), 'a-value')
        }
        finally
        {
            for (const session of sessions) await session.Dispose()
            await roles.Drop()
            await database.Dispose()
        }
    })
})
