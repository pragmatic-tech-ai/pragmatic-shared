import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { AppliedConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { AppliedConfigurationCodec } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { InMemoryConfigurationRepository } from '../../repository/in-memory-configuration-repository.js';
import { ConfigurationFixtures, TestClock } from '../../tests/fixtures/configuration-fixtures.js';
import { ConfigurationRuntimeReader } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { ConfigurationStartError, ConfigurationStartReason } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { SecretStoreDirectory } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import { SecretValue } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

class MapSecretStore implements ISecretStore
{
    public readonly Asked: string[] = [];

    public constructor(private readonly secrets: Map<string, string>)
    {
    }

    public Get(reference: string): Promise<string | null>
    {
        this.Asked.push(reference);
        return Promise.resolve(this.secrets.get(reference) ?? null);
    }

    public Put(reference: string, secret: string): Promise<void>
    {
        this.secrets.set(reference, secret);
        return Promise.resolve();
    }

    public Delete(reference: string): Promise<void>
    {
        this.secrets.delete(reference);
        return Promise.resolve();
    }
}

class ReaderFixture
{
    public static Store(): MapSecretStore
    {
        return new MapSecretStore(new Map([['google/client-secret', ConfigurationFixtures.SecretValue], ['google/client-secret@3', 'pinned-value']]));
    }

    public static async Applied(document: unknown = ConfigurationFixtures.Document()): Promise<AppliedConfiguration>
    {
        const repository = new InMemoryConfigurationRepository(new TestClock());
        const version = await repository.Save(ConfigurationFixtures.Save(ConfigurationFixtures.Scope(), 0, document));
        return AppliedConfiguration.From(version, ConfigurationFixtures.Descriptor());
    }

    /** Writes `text` as the mounted file in a fresh folder and runs `body` with its path. */
    public static async WithFile(text: string, body: (path: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'pragmatic-config-'));
        try
        {
            const path = join(folder, 'configuration.json');
            await writeFile(path, text, 'utf8');
            await body(path);
        }
        finally
        {
            await rm(folder, { recursive: true, force: true });
        }
    }

    public static Reader(store: ISecretStore = ReaderFixture.Store(), descriptor = ConfigurationFixtures.Descriptor()): ConfigurationRuntimeReader
    {
        return new ConfigurationRuntimeReader(descriptor, new SecretStoreDirectory().Add('realm', store));
    }

    public static async Rejects(promise: Promise<unknown>, reason: ConfigurationStartReason): Promise<void>
    {
        await assert.rejects(promise, (error: unknown) =>
        {
            assert.ok(error instanceof ConfigurationStartError, String(error));
            assert.equal(error.Reason, reason, error.message);
            assert.ok(!error.message.includes(ConfigurationFixtures.SecretValue));
            return true;
        });
    }
}

test('reads the mounted file, checks the descriptor, resolves secret references into secret values', async () =>
{
    const applied = await ReaderFixture.Applied();
    const store = ReaderFixture.Store();
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(applied), async path =>
    {
        const configuration = await ReaderFixture.Reader(store).Read(path);
        assert.equal(configuration.Version, 1);
        assert.equal(configuration.ComponentVersion, '0.3.0');
        assert.equal(configuration.DescriptorDigest, applied.DescriptorDigest);
        assert.equal(configuration.IsEnabled('google'), true);
        assert.equal(configuration.Value('local', 'passwordMinLength'), 14);
        assert.equal(configuration.Value('local', 'selfRegistration'), false);
        assert.deepEqual(configuration.Value('google', 'allowedDomains'), ['example.com']);
        assert.ok(configuration.Value('google', 'clientSecret') instanceof SecretReference);
        const secret = configuration.Secret('google', 'clientSecret');
        assert.ok(secret instanceof SecretValue);
        assert.equal(secret.Reveal(), ConfigurationFixtures.SecretValue);
        assert.equal(configuration.Secret('google', 'clientId'), undefined);
        assert.deepEqual(store.Asked, ['google/client-secret']);
        for (const shown of [String(secret), JSON.stringify(secret), inspect(secret), inspect(configuration, { depth: 10 }), JSON.stringify(configuration)])
        {
            assert.ok(!shown.includes(ConfigurationFixtures.SecretValue), shown);
        }
    });
});

test('a pinned version is asked for as <name>@<version>', async () =>
{
    const document = { options: { google: { clientId: 'client-1', clientSecret: 'secret:realm/google/client-secret@3' } } };
    const applied = await ReaderFixture.Applied(document);
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(applied), async path =>
    {
        assert.equal((await ReaderFixture.Reader().Read(path)).Secret('google', 'clientSecret')?.Reveal(), 'pinned-value');
    });
});

test('refuses to start when the configuration was validated against another descriptor', async () =>
{
    const applied = await ReaderFixture.Applied();
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(applied), async path =>
    {
        const newer = ConfigurationFixtures.Descriptor('0.4.0');
        await assert.rejects(ReaderFixture.Reader(ReaderFixture.Store(), newer).Read(path), (error: unknown) =>
        {
            assert.ok(error instanceof ConfigurationStartError);
            assert.equal(error.Reason, ConfigurationStartReason.DescriptorMismatch);
            assert.match(error.message, /version 1 of realm-sign-in/);
            assert.ok(error.message.includes(applied.DescriptorDigest));
            assert.ok(error.message.includes(newer.ContentDigest()));
            assert.ok(error.message.includes('0.4.0'));
            return true;
        });
    });
});

test('refuses to start on a missing, malformed, foreign or invalid file', async () =>
{
    await ReaderFixture.Rejects(ReaderFixture.Reader().Read(join(tmpdir(), 'pragmatic-config-none', 'configuration.json')), ConfigurationStartReason.Missing);
    await ReaderFixture.WithFile('{ broken', async path => ReaderFixture.Rejects(ReaderFixture.Reader().Read(path), ConfigurationStartReason.Malformed));
    const applied = await ReaderFixture.Applied();
    const foreign = new AppliedConfiguration(applied.Realm, 'tenant-admin', 1, applied.ComponentVersion, applied.DescriptorDigest, applied.Document);
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(foreign), async path => ReaderFixture.Rejects(ReaderFixture.Reader().Read(path), ConfigurationStartReason.ComponentMismatch));
    const literal = new AppliedConfiguration(applied.Realm, applied.Component, 1, applied.ComponentVersion, applied.DescriptorDigest, ConfigurationFixtures.LiteralSecretDocument());
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(literal), async path => ReaderFixture.Rejects(ReaderFixture.Reader().Read(path), ConfigurationStartReason.Invalid));
});

test('refuses to start when a secret store is unknown or a secret is absent', async () =>
{
    const document = { options: { google: { clientId: 'client-1', clientSecret: 'secret:vault/google/client-secret' } } };
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(await ReaderFixture.Applied(document)), async path =>
        ReaderFixture.Rejects(ReaderFixture.Reader().Read(path), ConfigurationStartReason.UnknownSecretStore));
    const absent = { options: { google: { clientId: 'client-1', clientSecret: 'secret:realm/google/rotated' } } };
    await ReaderFixture.WithFile(AppliedConfigurationCodec.Encode(await ReaderFixture.Applied(absent)), async path =>
        ReaderFixture.Rejects(ReaderFixture.Reader().Read(path), ConfigurationStartReason.SecretMissing));
});

test('the default path is the mounted volume; PRAGMATIC_CONFIGURATION_FILE overrides it', () =>
{
    assert.equal(ConfigurationRuntimeReader.DefaultPath, '/etc/pragmatic/configuration/configuration.json');
    assert.equal(ConfigurationRuntimeReader.PathFrom({}), ConfigurationRuntimeReader.DefaultPath);
    assert.equal(ConfigurationRuntimeReader.PathFrom({ PRAGMATIC_CONFIGURATION_FILE: '/tmp/c.json' }), '/tmp/c.json');
    assert.equal(ConfigurationRuntimeReader.PathFrom({ PRAGMATIC_CONFIGURATION_FILE: '' }), ConfigurationRuntimeReader.DefaultPath);
});

test('a secret store directory refuses a malformed or duplicate store name', () =>
{
    const directory = new SecretStoreDirectory().Add('realm', ReaderFixture.Store());
    assert.throws(() => directory.Add('realm', ReaderFixture.Store()));
    assert.throws(() => directory.Add('Bad Name', ReaderFixture.Store()));
});
