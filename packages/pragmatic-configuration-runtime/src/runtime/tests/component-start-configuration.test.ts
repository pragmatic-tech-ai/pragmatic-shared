import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComponentStartConfiguration, ComponentStartReport } from '../component-start-configuration.js';
import type { IStartProcess } from '../component-start-configuration.js';
import { ConfigurationStartError, ConfigurationStartReason } from '../configuration-start-error.js';
import { StartFixture } from './start-fixture.js';

class StartCase
{
    public static Env(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv
    {
        return { PRAGMATIC_CONFIGURATION_FILE: path, TEST_REGISTRY_URL: 'https://env.example/', TEST_POLL_INTERVAL_MS: '5000', ...extra };
    }

    public static async Rejects(promise: Promise<unknown>, reason: ConfigurationStartReason): Promise<ConfigurationStartError>
    {
        let caught: unknown;
        await promise.catch(error => { caught = error; });
        assert.ok(caught instanceof ConfigurationStartError, `expected ConfigurationStartError, got ${String(caught)}`);
        assert.equal(caught.Reason, reason);
        return caught;
    }
}

class RecordingProcess implements IStartProcess
{
    public Code: number | undefined;
    public Written = '';
    public readonly stderr = { write: (text: string): boolean => { this.Written += text; return true; } };

    public exit(code: number): never
    {
        this.Code = code;
        throw new Error('exited');
    }
}

test('no file leaves the environment unchanged and reports none', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const env = StartCase.Env(join(folder, 'absent.json'));
        const before = { ...env };
        const report = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') });
        assert.equal(report, ComponentStartReport.None);
        assert.equal(report.Applied, false);
        assert.equal(report.Version, null);
        assert.equal(report.Realm, null);
        assert.deepEqual(env, before);
        await assert.rejects(stat(join(folder, 'secrets')));
    });
});

test('a configured setting overrides its variable', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', pollIntervalMs: 15000, verbose: false, hosts: ['a', 'b,c'] }));
        const env = StartCase.Env(path, { TEST_VERBOSE: 'true' });
        const report = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') });
        assert.equal(env.TEST_REGISTRY_URL, 'https://configured.example/');
        assert.equal(env.TEST_POLL_INTERVAL_MS, '15000');
        assert.equal(env.TEST_VERBOSE, 'false');
        assert.equal(env.TEST_HOSTS, '["a","b,c"]');
        assert.equal(report.Version, 4);
        assert.equal(report.Realm, StartFixture.Realm);
        assert.deepEqual(report.Settings, ['core.registryUrl', 'core.pollIntervalMs', 'core.verbose', 'core.hosts']);
    });
});

test('an unconfigured setting keeps the environment value', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/' }));
        const env = StartCase.Env(path, { TEST_EXTRA_MODE: 'from-env' });
        const report = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') });
        // pollIntervalMs is the descriptor default in the applied document: the variable already set wins.
        assert.equal(env.TEST_POLL_INTERVAL_MS, '5000');
        assert.equal(env.TEST_VERBOSE, undefined);
        assert.equal(env.TEST_HOSTS, undefined);
        // an option not enabled overlays nothing
        assert.equal(env.TEST_EXTRA_MODE, 'from-env');
        assert.deepEqual(report.Settings, ['core.registryUrl']);
    });
});

test('a default fills a variable the environment does not set', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/' }));
        const env: NodeJS.ProcessEnv = { PRAGMATIC_CONFIGURATION_FILE: path };
        await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') });
        assert.equal(env.TEST_POLL_INTERVAL_MS, '30000');
    });
});

test('a secret setting becomes a 0400 file and its _FILE variable, never a value in the environment', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const secrets = join(folder, 'secrets');
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference, key: StartFixture.KeyReference }));
        const env = StartCase.Env(path, { TEST_TOKEN: 'injected-by-the-deployment' });
        const report = await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: secrets });
        assert.equal(env.TEST_TOKEN, undefined, 'the plain variable is removed');
        assert.equal(env.TEST_TOKEN_FILE, join(secrets, 'core.token'));
        assert.equal(env.TEST_KEY_FILE, join(secrets, 'core.key'), 'a source naming a file is that file variable');
        assert.equal(await readFile(join(secrets, 'core.token'), 'utf8'), StartFixture.Token);
        assert.equal(await readFile(join(secrets, 'core.key'), 'utf8'), StartFixture.Key);
        for (const file of ['core.token', 'core.key'])
        {
            const mode = (await stat(join(secrets, file))).mode & 0o777;
            assert.equal(mode & 0o222, 0, `${file} is not writable`);
            if (process.platform !== 'win32') assert.equal(mode, 0o400, `${file} is 0400`);
        }
        const text = JSON.stringify(env) + JSON.stringify(report);
        assert.ok(!text.includes(StartFixture.Token) && !text.includes(StartFixture.Key), 'no secret value in the environment or the report');
        assert.deepEqual(report.Settings, ['core.registryUrl', 'core.token', 'core.key']);
    });
});

test('a second Apply over the same directory replaces the files', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const secrets = join(folder, 'secrets');
        const first = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference, key: StartFixture.KeyReference }));
        await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(first), Stores: StartFixture.Stores(), SecretsDir: secrets });
        await mkdir(join(secrets, 'nested'));
        await writeFile(join(secrets, 'stale.leftover'), 'old');
        const second = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference }, 5));
        const rotated = new Map([['agent-token', 'rotated-token-2b']]);
        const env = StartCase.Env(second);
        await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(rotated), SecretsDir: secrets });
        assert.equal(await readFile(join(secrets, 'core.token'), 'utf8'), 'rotated-token-2b');
        assert.deepEqual((await readdir(secrets)).sort(), ['core.token', 'nested']);
        assert.equal(env.TEST_KEY_FILE, undefined);
    });
});

test('a descriptor mismatch refuses the start naming both digests', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const other = StartFixture.Applied({ registryUrl: 'https://configured.example/' }, 4, StartFixture.Declaration('0.2.0'));
        const path = await StartFixture.Configuration(folder, other);
        const env = StartCase.Env(path);
        const before = { ...env };
        const error = await StartCase.Rejects(ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') }), ConfigurationStartReason.DescriptorMismatch);
        const own = (await import('@pragmatic-tech-ai/pragmatic-component')).ComponentDeclarations.Build(StartFixture.Declaration()).ContentDigest();
        assert.ok(error.message.includes(other.DescriptorDigest), 'names the version digest');
        assert.ok(error.message.includes(own), 'names the container digest');
        assert.deepEqual(env, before);
    });
});

test('an unknown secret store refuses naming the setting and reference', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: 'secret:vault/agent-token' }));
        const error = await StartCase.Rejects(ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(path), Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') }), ConfigurationStartReason.UnknownSecretStore);
        assert.ok(error.message.includes('core.token'));
        assert.ok(error.message.includes('secret:vault/agent-token'));
    });
});

test('an invalid configuration refuses the start', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ pollIntervalMs: 'often' }));
        await StartCase.Rejects(ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(path), Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') }), ConfigurationStartReason.Invalid);
    });
});

test('an unwritable secrets directory refuses the start without the value', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const blocker = join(folder, 'blocker');
        await writeFile(blocker, 'a file where the directory should be');
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference }));
        const error = await StartCase.Rejects(ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(path), Stores: StartFixture.Stores(), SecretsDir: join(blocker, 'secrets') }), ConfigurationStartReason.SecretsUnwritable);
        assert.ok(!error.message.includes(StartFixture.Token));
    });
});

test('ApplyOrExit exits 78 with the reason on a refused start, and returns the report otherwise', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const bad = await StartFixture.Configuration(folder, '{ not json');
        const process = new RecordingProcess();
        await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(bad), Stores: StartFixture.Stores(), SecretsDir: join(folder, 'secrets') }, process), /exited/);
        assert.equal(process.Code, ComponentStartConfiguration.ExitCode);
        assert.equal(process.Code, 78);
        assert.match(process.Written, /pragmatic-test-agent: cannot start on the applied configuration: .*\(malformed\)\n$/);

        const fine = new RecordingProcess();
        const report = await ComponentStartConfiguration.ApplyOrExit({ Declaration: StartFixture.Declaration(), Env: StartCase.Env(join(folder, 'absent.json')), Stores: StartFixture.Stores() }, fine);
        assert.equal(report.Applied, false);
        assert.equal(fine.Code, undefined);
    });
});

test('the default stores resolve store file from the mounted per-component Secret', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        await mkdir(join(folder, StartFixture.Name));
        await writeFile(join(folder, StartFixture.Name, 'agent-token'), StartFixture.Token);
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://configured.example/', token: StartFixture.TokenReference }));
        const env = StartCase.Env(path);
        await ComponentStartConfiguration.Apply({ Declaration: StartFixture.Declaration(), Env: env, Stores: ComponentStartConfiguration.Stores(StartFixture.Name, folder), SecretsDir: join(folder, 'secrets') });
        assert.equal(await readFile(env.TEST_TOKEN_FILE as string, 'utf8'), StartFixture.Token);
        assert.equal(ComponentStartConfiguration.MountedSecretsRoot, '/run/secrets/pragmatic');
        assert.equal(ComponentStartConfiguration.DefaultSecretsDir, '/run/pragmatic/secrets');
    });
});
