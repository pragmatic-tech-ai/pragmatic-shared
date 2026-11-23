import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import { ComponentStartConfiguration } from '../component-start-configuration.js';
import { ConfigurationStartError, ConfigurationStartReason } from '../configuration-start-error.js';
import { MountedSecretStore } from '../mounted-secret-store.js';
import { SecretStoreDirectory } from '../secret-store-directory.js';
import { SecretVariable } from '../secret-variable.js';
import { StartFixture } from './start-fixture.js';

class ReviewCase
{
    public static Env(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv
    {
        return { PRAGMATIC_CONFIGURATION_FILE: path, TEST_POLL_INTERVAL_MS: '5000', ...extra };
    }

    public static async Reason(promise: Promise<unknown>): Promise<ConfigurationStartReason | undefined>
    {
        try
        {
            await promise;
            return undefined;
        }
        catch (error)
        {
            assert.ok(error instanceof ConfigurationStartError, String(error));
            return error.Reason;
        }
    }
}

test('a configuration without secrets never touches the secrets directory', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const blocker = join(folder, 'blocker');
        await writeFile(blocker, 'a file where the directory would be');
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/' }));
        const env = ReviewCase.Env(path);
        const report = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(blocker, 'secrets') });
        assert.equal(env.TEST_REGISTRY_URL, 'https://configured.example/');
        assert.deepEqual(report.Settings, ['core.registryUrl']);
    });
});

test('a default kept for the environment is reported by name; an empty variable counts as unset', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/' }));
        const kept = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: ReviewCase.Env(path), Stores: StartFixture.Stores(), SecretsDir: join(folder, 's') });
        assert.deepEqual(kept.Kept, ['core.pollIntervalMs']);
        const empty = ReviewCase.Env(path, { TEST_POLL_INTERVAL_MS: '' });
        const filled = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: empty, Stores: StartFixture.Stores(), SecretsDir: join(folder, 's') });
        assert.equal(empty.TEST_POLL_INTERVAL_MS, '30000');
        assert.deepEqual(filled.Kept, []);
    });
});

test('a link left in the secrets directory is removed, never written through', async (t) =>
{
    await StartFixture.InFolder(async folder =>
    {
        const secrets = join(folder, 'secrets');
        const outside = join(folder, 'outside');
        await mkdir(secrets);
        await writeFile(outside, 'untouched');
        try
        {
            await symlink(outside, join(secrets, 'core.token'));
        }
        catch
        {
            t.skip('this host cannot create a symbolic link');
            return;
        }
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference }));
        await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: ReviewCase.Env(path), Stores: StartFixture.Stores(), SecretsDir: secrets });
        assert.equal(await readFile(outside, 'utf8'), 'untouched');
        assert.equal(await readFile(join(secrets, 'core.token'), 'utf8'), StartFixture.Token);
    });
});

test('a store that fails refuses the start as secret-unreadable, naming the reference and not its text', async () =>
{
    const failing = { Get: async (): Promise<string | null> => { throw Object.assign(new Error('leaked-store-text'), { code: 'EACCES' }); } };
    const directory = new SecretStoreDirectory().Add('file', failing);
    let caught: unknown;
    await directory.Resolve(new SecretReference('file', 'agent-token'), 'core.token').catch(error => { caught = error; });
    assert.ok(caught instanceof ConfigurationStartError);
    assert.equal(caught.Reason, ConfigurationStartReason.SecretUnreadable);
    assert.match(caught.message, /core\.token.*secret:file\/agent-token.*EACCES/);
    assert.ok(!caught.message.includes('leaked-store-text'));
});

test('a mounted store refuses a pinned version and drops one trailing line break', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        await writeFile(join(folder, 'agent-token'), 'value-2\n');
        const store = new MountedSecretStore(folder);
        assert.equal(await store.Get('agent-token'), 'value-2');
        const directory = new SecretStoreDirectory().Add('file', store);
        assert.equal(await ReviewCase.Reason(directory.Resolve(new SecretReference('file', 'agent-token', '3'), 'core.token')), ConfigurationStartReason.SecretUnreadable);
    });
});

test('a source that already names a file is read as that file', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const file = join(folder, 'key');
        await writeFile(file, 'key-value');
        assert.equal(SecretVariable.Read({ TEST_KEY_FILE: file }, 'TEST_KEY_FILE'), 'key-value');
        assert.equal(SecretVariable.Read({}, 'TEST_KEY_FILE'), undefined);
    });
});
