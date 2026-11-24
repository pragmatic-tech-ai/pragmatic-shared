import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { CloudSecretManagerSecretStore, CustomRealmSecretStore, RealmSecretsMigrations, RealmSecretsOption, SqlMigrationRunner, SqlSecretMigrations } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { SqlTestSessions, type SqlLiveTestDatabase } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import { GcpRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-gcp';
import { AzureRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-azure';
import { AwsRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-aws';
import { ConfigurationStartError, ConfigurationStartReason } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { NoRealmSecretsHomeError, RealmSecretWriter } from '../../repository/realm-secret-writer.js';
import { RealmSecretsDirectory, RealmSecretsHomes, type IRealmSecretsOptionLoader } from '../realm-secrets-directory.js';

class DirectoryCase
{
    public static readonly Audience = '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pragmatic-hives/providers/customer';

    public static async InFolder(body: (folder: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'realm-dir-'));
        try
        {
            await body(folder);
        }
        finally
        {
            await rm(folder, { recursive: true, force: true });
        }
    }

    public static Workload(token: string, extra: Record<string, string>): Record<string, string>
    {
        return { PRAGMATIC_REALM_ID: 'acme', PRAGMATIC_COMPONENT: 'pragmatic-tenant-idp', PRAGMATIC_WORKLOAD_TOKEN_FILE: token, ...extra };
    }

    public static async Refusal(promise: Promise<unknown>): Promise<ConfigurationStartError>
    {
        try
        {
            await promise;
        }
        catch (error)
        {
            assert.ok(error instanceof ConfigurationStartError, String(error));
            return error;
        }
        assert.fail('expected a refused start');
    }

    /** The custom home's files over a live test schema; the test role holds the grant rows itself (no provisioning). */
    public static async CustomFiles(database: SqlLiveTestDatabase, folder: string, key: Buffer): Promise<Record<string, string>>
    {
        const session = database.Session();
        await SqlMigrationRunner.Run(session, new SqlSecretMigrations());
        await SqlMigrationRunner.Run(session, new RealmSecretsMigrations());
        await session.Execute("INSERT INTO realm_secret_grants (role_name, realm_id, writer) VALUES (current_user, 'acme', true) ON CONFLICT DO NOTHING", []);
        const live = new URL(process.env.PRAGMATIC_TEST_PG_URL!);
        live.searchParams.set('options', `-c search_path=${database.Schema}`);
        const url = join(folder, 'database-url');
        const keyFile = join(folder, 'key-' + randomBytes(4).toString('hex'));
        await writeFile(url, live.toString() + '\n');
        await writeFile(keyFile, key.toString('base64'));
        return { PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: url, PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: keyFile };
    }
}

class FailingLoader implements IRealmSecretsOptionLoader
{
    public Load(): Promise<never>
    {
        return Promise.reject(new Error('Cannot find package @pragmatic-tech-ai/pragmatic-realm-gcp'));
    }
}

test('without a realm secrets option the directory has the mounted store only', async () =>
{
    const directory = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', {});
    assert.equal((await DirectoryCase.Refusal(directory.Resolve(new SecretReference('realm', 'x'), 'google.clientSecret'))).Reason, ConfigurationStartReason.UnknownSecretStore);
    assert.equal(RealmSecretsDirectory.Configured({}), false);
    await assert.rejects(RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', {}), NoRealmSecretsHomeError);
});

test('secret:realm/x resolves through the realm option\'s home', async () =>
{
    await DirectoryCase.InFolder(async folder =>
    {
        const token = join(folder, 'token');
        await writeFile(token, 'projected.jwt');
        const cases: [Record<string, string>, new (...args: never[]) => ISecretStore][] = [
            [{ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp', PRAGMATIC_REALM_SECRETS_PROJECT_ID: 'pragmatic-ops', PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE: DirectoryCase.Audience }, GcpRealmSecretStore],
            [{ PRAGMATIC_REALM_SECRETS_OPTION: 'azure', PRAGMATIC_REALM_SECRETS_TENANT_ID: '11111111-2222-3333-4444-555555555555', PRAGMATIC_REALM_SECRETS_CLIENT_ID: '66666666-7777-8888-9999-000000000000', PRAGMATIC_REALM_SECRETS_VAULT_URL: 'https://acme-realm.vault.azure.net' }, AzureRealmSecretStore],
            [{ PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/pragmatic-realm-acme' }, AwsRealmSecretStore],
        ];
        for (const [env, kind] of cases)
        {
            const store = await RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload(token, env));
            assert.ok(store instanceof kind, env.PRAGMATIC_REALM_SECRETS_OPTION);
        }
    });
    // The directory asks the realm store for the reference's name (and pinned version).
    const home = new CloudSecretManagerSecretStore();
    await home.Put('google-client-secret@2', 'pinned');
    await home.Put('google-client-secret', 'latest');
    const directory = (await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', {})).Add('realm', home);
    assert.equal((await directory.Resolve(new SecretReference('realm', 'google-client-secret'), 'google.clientSecret')).Reveal(), 'latest');
    assert.equal((await directory.Resolve(new SecretReference('realm', 'google-client-secret', '2'), 'google.clientSecret')).Reveal(), 'pinned');
});

test('a start with an unreachable home refuses with the reason secrets-home-unavailable, naming the option and code', async () =>
{
    await DirectoryCase.InFolder(async folder =>
    {
        const url = join(folder, 'database-url');
        const key = join(folder, 'key');
        await writeFile(url, 'postgres://nobody:nothing@127.0.0.1:1/realm_secrets');
        await writeFile(key, randomBytes(32));
        const custom = await DirectoryCase.Refusal(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload(join(folder, 'token'), { PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: url, PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: key })));
        assert.equal(custom.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
        assert.match(custom.message, /\(custom\) unreachable/);
        // A token that cannot be read is the same reason, found when the directory is built.
        const cloud = await DirectoryCase.Refusal(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload(join(folder, 'no-token'), { PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/r' })));
        assert.equal(cloud.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
        assert.match(cloud.message, /\(aws\) token-unreadable/);
    });
    // Refused settings and an incomplete workload refuse when the directory is built.
    const token = '/var/run/secrets/pragmatic/workload-identity/token';
    for (const env of [
        DirectoryCase.Workload(token, { PRAGMATIC_REALM_SECRETS_OPTION: 'gcp' }),
        DirectoryCase.Workload(token, { PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/r', PRAGMATIC_REALM_SECRETS_SECRET_ACCESS_KEY: 'x' }),
        { PRAGMATIC_REALM_SECRETS_OPTION: 'custom' },
        { PRAGMATIC_REALM_SECRETS_OPTION: 'hashicorp' },
    ])
    {
        assert.equal((await DirectoryCase.Refusal(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', env))).Reason, ConfigurationStartReason.SecretsHomeUnavailable);
    }
});

test('an option package that does not load refuses the start as secrets-home-unavailable', async () =>
{
    const refusal = await DirectoryCase.Refusal(RealmSecretsHomes.Factory(RealmSecretsOption.Gcp, new FailingLoader()));
    assert.equal(refusal.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
    assert.match(refusal.message, /package could not be loaded: gcp/);
    assert.doesNotMatch(refusal.message, /Cannot find package/);
    const viaDirectory = await DirectoryCase.Refusal(RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload('/t', { PRAGMATIC_REALM_SECRETS_OPTION: 'gcp', PRAGMATIC_REALM_SECRETS_PROJECT_ID: 'pragmatic-ops', PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE: DirectoryCase.Audience }), undefined, new FailingLoader()));
    assert.equal(viaDirectory.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
});

test('the writer answers a reference and never echoes the value', async () =>
{
    const home = new CloudSecretManagerSecretStore();
    const writer = new RealmSecretWriter(home);
    const reference = await writer.Put('google-client-secret', 'entered-value');
    assert.equal(reference.Format(), 'secret:realm/google-client-secret');
    assert.equal(await home.Get('google-client-secret'), 'entered-value');
    assert.equal(await writer.Holds('google-client-secret'), true);
    assert.ok(!inspect(reference).includes('entered-value'));
    assert.ok(!JSON.stringify(reference).includes('entered-value'));
    await assert.rejects(writer.Put('Google/Secret', 'v'), /one segment/);
    await writer.Delete('google-client-secret');
    assert.equal(await writer.Holds('google-client-secret'), false);
});

// Live: the custom home through its URL and key files, written by the console's writer and read at start.
SqlTestSessions.DescribeLive('the custom realm secrets home end to end', makeDatabase =>
{
    test('[live] the custom home is used when the option is custom: the console writes, a reader resolves the reference', async () =>
    {
        const database = await makeDatabase();
        await DirectoryCase.InFolder(async folder =>
        {
            const common = await DirectoryCase.CustomFiles(database, folder, randomBytes(32));
            const writer = await RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', DirectoryCase.Workload(join(folder, 'token'), { ...common, PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin', PRAGMATIC_REALM_SECRETS_ACCESS: 'writer' }));
            const reference = await writer.Put('probe', 'live-value');
            const store = await RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload(join(folder, 'token'), common));
            assert.ok(store instanceof CustomRealmSecretStore);
            assert.equal(store.Writer, false);
            const directory = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload(join(folder, 'token'), common));
            assert.equal((await directory.Resolve(reference, 'google.clientSecret')).Reveal(), 'live-value');
        });
        await database.Dispose();
    });

    test('[live] a replaced master key refuses every component\'s start, the console\'s writer included', async () =>
    {
        const database = await makeDatabase();
        await DirectoryCase.InFolder(async folder =>
        {
            const original = await DirectoryCase.CustomFiles(database, folder, randomBytes(32));
            const consoleEnv = { ...original, PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin', PRAGMATIC_REALM_SECRETS_ACCESS: 'writer' };
            await (await RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', DirectoryCase.Workload(join(folder, 'token'), consoleEnv))).Put('probe', 'v');
            const replaced = await DirectoryCase.CustomFiles(database, folder, randomBytes(32));
            const reader = await DirectoryCase.Refusal(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload(join(folder, 'token'), replaced)));
            assert.equal(reader.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
            assert.match(reader.message, /\(custom\) key-mismatch/);
            const writer = await DirectoryCase.Refusal(RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', DirectoryCase.Workload(join(folder, 'token'), { ...replaced, PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin', PRAGMATIC_REALM_SECRETS_ACCESS: 'writer' })));
            assert.match(writer.message, /key-mismatch/);
        });
        await database.Dispose();
    });
});
