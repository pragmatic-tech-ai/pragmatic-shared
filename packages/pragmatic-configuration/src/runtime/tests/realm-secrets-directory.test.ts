import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { CloudSecretManagerSecretStore, CustomRealmSecretStore, SqlMigrationRunner, SqlSecretMigrations } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import { GcpRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-gcp';
import { AzureRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-azure';
import { AwsRealmSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-aws';
import { ConfigurationStartError, ConfigurationStartReason } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { NoRealmSecretsHomeError, RealmSecretWriter } from '../../repository/realm-secret-writer.js';
import { RealmSecretsDirectory } from '../realm-secrets-directory.js';

class DirectoryCase
{
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

    public static Workload(extra: Record<string, string>): Record<string, string>
    {
        return { PRAGMATIC_REALM_ID: 'acme', PRAGMATIC_COMPONENT: 'pragmatic-tenant-idp', PRAGMATIC_WORKLOAD_TOKEN_FILE: '/var/run/secrets/pragmatic/workload-identity/token', ...extra };
    }

    public static async Reason(promise: Promise<unknown>): Promise<ConfigurationStartReason>
    {
        try
        {
            await promise;
        }
        catch (error)
        {
            assert.ok(error instanceof ConfigurationStartError, String(error));
            return error.Reason;
        }
        assert.fail('expected a refused start');
    }
}

test('without a realm secrets option the directory has the mounted store only', async () =>
{
    const directory = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', {});
    assert.equal(await DirectoryCase.Reason(directory.Resolve(new SecretReference('realm', 'x'), 'google.clientSecret')), ConfigurationStartReason.UnknownSecretStore);
    assert.equal(RealmSecretsDirectory.Configured({}), false);
    await assert.rejects(RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', {}), NoRealmSecretsHomeError);
});

test('secret:realm/x resolves through the realm option\'s home', async () =>
{
    const cases: [Record<string, string>, new (...args: never[]) => ISecretStore][] = [
        [{ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp', PRAGMATIC_REALM_SECRETS_PROJECT_ID: 'pragmatic-ops', PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pragmatic-hives/providers/customer' }, GcpRealmSecretStore],
        [{ PRAGMATIC_REALM_SECRETS_OPTION: 'azure', PRAGMATIC_REALM_SECRETS_TENANT_ID: '11111111-2222-3333-4444-555555555555', PRAGMATIC_REALM_SECRETS_CLIENT_ID: '66666666-7777-8888-9999-000000000000', PRAGMATIC_REALM_SECRETS_VAULT_URL: 'https://acme-realm.vault.azure.net' }, AzureRealmSecretStore],
        [{ PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/pragmatic-realm-acme' }, AwsRealmSecretStore],
    ];
    for (const [env, kind] of cases)
    {
        const store = await RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload(env));
        assert.ok(store instanceof kind, env.PRAGMATIC_REALM_SECRETS_OPTION);
    }
    // The directory asks the realm store for the reference's name (and pinned version).
    const home = new CloudSecretManagerSecretStore();
    await home.Put('google-client-secret@2', 'pinned');
    await home.Put('google-client-secret', 'latest');
    const directory = (await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', {})).Add('realm', home);
    assert.equal((await directory.Resolve(new SecretReference('realm', 'google-client-secret'), 'google.clientSecret')).Reveal(), 'latest');
    assert.equal((await directory.Resolve(new SecretReference('realm', 'google-client-secret', '2'), 'google.clientSecret')).Reveal(), 'pinned');
});

test('the custom home is used when the option is custom', async () =>
{
    const store = await RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: '/run/secrets/pragmatic/realm-secrets/database-url', PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: '/run/secrets/pragmatic/realm-master-key/key' }));
    assert.ok(store instanceof CustomRealmSecretStore);
    assert.equal(store.RealmId, 'acme');
    assert.equal(store.Writer, false);
    const forStaff = await RealmSecretsDirectory.RealmStoreFor('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: '/x', PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: '/y', PRAGMATIC_REALM_SECRETS_ACCESS: 'writer' }), 'staff');
    assert.ok(forStaff instanceof CustomRealmSecretStore);
    assert.equal(forStaff.RealmId, 'staff');
    assert.equal(forStaff.Writer, true);
});

test('a start with an unreachable home refuses with the reason secrets-home-unavailable', async () =>
{
    await DirectoryCase.InFolder(async folder =>
    {
        const url = join(folder, 'database-url');
        const key = join(folder, 'key');
        await writeFile(url, 'postgres://nobody:nothing@127.0.0.1:1/realm_secrets');
        await writeFile(key, randomBytes(32));
        const directory = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: url, PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: key }));
        assert.equal(await DirectoryCase.Reason(directory.Resolve(new SecretReference('realm', 'google-client-secret'), 'google.clientSecret')), ConfigurationStartReason.SecretsHomeUnavailable);
        // A token that cannot be read is the same reason.
        const cloud = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_WORKLOAD_TOKEN_FILE: join(folder, 'no-token'), PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/r' }));
        const refused = await cloud.Resolve(new SecretReference('realm', 'probe'), 'core.probe').catch((error: unknown) => error);
        assert.ok(refused instanceof ConfigurationStartError);
        assert.equal(refused.Reason, ConfigurationStartReason.SecretsHomeUnavailable);
        assert.match(refused.message, /token-unreadable/);
    });
    // Refused settings and an incomplete workload refuse when the directory is built.
    assert.equal(await DirectoryCase.Reason(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp' }))), ConfigurationStartReason.SecretsHomeUnavailable);
    assert.equal(await DirectoryCase.Reason(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload({ PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-central-1', PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/r', PRAGMATIC_REALM_SECRETS_SECRET_ACCESS_KEY: 'x' }))), ConfigurationStartReason.SecretsHomeUnavailable);
    assert.equal(await DirectoryCase.Reason(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', { PRAGMATIC_REALM_SECRETS_OPTION: 'custom' })), ConfigurationStartReason.SecretsHomeUnavailable);
    assert.equal(await DirectoryCase.Reason(RealmSecretsDirectory.Stores('pragmatic-tenant-idp', { PRAGMATIC_REALM_SECRETS_OPTION: 'hashicorp' })), ConfigurationStartReason.SecretsHomeUnavailable);
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
    test('[live] the console writes through the custom home and a reader resolves the reference', async () =>
    {
        const database = await makeDatabase();
        await SqlMigrationRunner.Run(database.Session(), new SqlSecretMigrations());
        await DirectoryCase.InFolder(async folder =>
        {
            const live = new URL(process.env.PRAGMATIC_TEST_PG_URL!);
            live.searchParams.set('options', `-c search_path=${database.Schema}`);
            const url = join(folder, 'database-url');
            const key = join(folder, 'key');
            await writeFile(url, live.toString() + '\n');
            await writeFile(key, randomBytes(32).toString('base64'));
            const common = { PRAGMATIC_REALM_SECRETS_OPTION: 'custom', PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: url, PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: key };
            const writer = await RealmSecretWriter.FromEnvironment('pragmatic-tenant-admin', DirectoryCase.Workload({ ...common, PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin', PRAGMATIC_REALM_SECRETS_ACCESS: 'writer' }));
            const reference = await writer.Put('probe', 'live-value');
            const directory = await RealmSecretsDirectory.Stores('pragmatic-tenant-idp', DirectoryCase.Workload(common));
            assert.equal((await directory.Resolve(reference, 'google.clientSecret')).Reveal(), 'live-value');
        });
        await database.Dispose();
    });
});
