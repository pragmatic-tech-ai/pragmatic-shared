import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ComponentDeclarations } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfiguration } from '../../applied/applied-configuration.js';
import { AppliedConfigurationEntries } from '../../applied/applied-configuration-entries.js';
import { ComponentStartConfiguration } from '../component-start-configuration.js';
import { ConfigurationRuntimeReader } from '../configuration-runtime-reader.js';
import { ConfigurationStartError, ConfigurationStartReason } from '../configuration-start-error.js';
import { StartFixture } from './start-fixture.js';

/** A container upgraded from 0.1.0 to 0.2.0: its applied file is still 0.1.0's, a prepared entry may sit beside it. */
class PreparedCase
{
    public static readonly Old = StartFixture.Declaration('0.1.0');
    public static readonly New = StartFixture.Declaration('0.2.0');

    public static Reader(declaration = PreparedCase.New, revalidate = false): ConfigurationRuntimeReader
    {
        return new ConfigurationRuntimeReader(ComponentDeclarations.Build(declaration), StartFixture.Stores(), revalidate);
    }

    public static DigestOf(declaration = PreparedCase.New): string
    {
        return ComponentDeclarations.Build(declaration).ContentDigest();
    }

    public static async Entry(primary: string, applied: AppliedConfiguration, digest = applied.DescriptorDigest): Promise<string>
    {
        const path = join(dirname(primary), AppliedConfigurationEntries.KeyOf(digest));
        await writeFile(path, applied.ToCanonicalJson(), 'utf8');
        return path;
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
        assert.fail('the read did not refuse');
    }
}

test('a container reads the prepared entry for its own descriptor when configuration.json was validated for another', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'https://new.example/' }, 4, PreparedCase.New));
        const read = await PreparedCase.Reader().Read(path);
        assert.equal(read.Version, 4);
        assert.equal(read.ComponentVersion, '0.2.0');
        assert.equal(read.DescriptorDigest, PreparedCase.DigestOf());
        assert.equal(read.Revalidated, false);
        assert.equal(String(read.Value('core', 'registryUrl')), 'https://new.example/');
    });
});

test('the old container keeps reading configuration.json with prepared entries beside it', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'https://new.example/' }, 4, PreparedCase.New));
        const read = await PreparedCase.Reader(PreparedCase.Old).Read(path);
        assert.equal(read.Version, 3);
        assert.equal(String(read.Value('core', 'registryUrl')), 'https://old.example/');
    });
});

test('configuration.json wins over a stale entry for the same descriptor', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://applied.example/' }, 5, PreparedCase.New));
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'https://stale.example/' }, 4, PreparedCase.New));
        const read = await PreparedCase.Reader().Read(path);
        assert.equal(read.Version, 5);
        assert.equal(String(read.Value('core', 'registryUrl')), 'https://applied.example/');
    });
});

test('the single-entry format reads as one entry, exactly as before', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://only.example/' }, 2, PreparedCase.New));
        const report = await ComponentStartConfiguration.Apply({ Declaration: PreparedCase.New, Env: { PRAGMATIC_CONFIGURATION_FILE: path }, Stores: StartFixture.Stores(), SecretsDir: join(folder, 's') });
        assert.equal(report.Version, 2);
        assert.equal(report.Revalidated, false);
    });
});

test('without an entry for its descriptor the container still refuses, naming both digests', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        const other = StartFixture.Declaration('0.3.0');
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'https://other.example/' }, 4, other));
        const error = await PreparedCase.Refusal(PreparedCase.Reader().Read(path));
        assert.equal(error.Reason, ConfigurationStartReason.DescriptorMismatch);
        assert.match(error.message, new RegExp(PreparedCase.DigestOf(PreparedCase.Old)));
        assert.match(error.message, new RegExp(PreparedCase.DigestOf()));
        assert.match(error.message, /no configuration prepared/);
    });
});

test('an entry whose content names another descriptor than its key, or another realm, is malformed', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'https://forged.example/' }, 4, PreparedCase.Old), PreparedCase.DigestOf());
        assert.equal((await PreparedCase.Refusal(PreparedCase.Reader().Read(path))).Reason, ConfigurationStartReason.Malformed);
        const descriptor = ComponentDeclarations.Build(PreparedCase.New);
        const otherRealm = new AppliedConfiguration('realm-other', descriptor.Name, 4, descriptor.Version, descriptor.ContentDigest(), { options: { core: { registryUrl: 'https://x.example/' } } });
        await PreparedCase.Entry(path, otherRealm);
        assert.equal((await PreparedCase.Refusal(PreparedCase.Reader().Read(path))).Reason, ConfigurationStartReason.Malformed);
    });
});

test('a prepared entry that does not validate refuses as invalid', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        await PreparedCase.Entry(path, StartFixture.Applied({ registryUrl: 'not a url' }, 4, PreparedCase.New));
        assert.equal((await PreparedCase.Refusal(PreparedCase.Reader().Read(path))).Reason, ConfigurationStartReason.Invalid);
    });
});

test('a revalidating reader (the console) runs an applied document that validates against its own descriptor, and says so', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/' }, 3, PreparedCase.Old));
        const read = await PreparedCase.Reader(PreparedCase.New, true).Read(path);
        assert.equal(read.Version, 3);
        assert.equal(read.Revalidated, true);
        const report = await ComponentStartConfiguration.Apply({ Declaration: PreparedCase.New, Env: { PRAGMATIC_CONFIGURATION_FILE: path }, Stores: StartFixture.Stores(), SecretsDir: join(folder, 's'), Revalidate: true });
        assert.equal(report.Revalidated, true);
        assert.equal(report.Version, 3);
    });
});

test('a revalidating reader still refuses an applied document its own descriptor rejects', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, StartFixture.Applied({ registryUrl: 'https://old.example/', retired: 'x' }, 3, PreparedCase.Old));
        const error = await PreparedCase.Refusal(PreparedCase.Reader(PreparedCase.New, true).Read(path));
        assert.equal(error.Reason, ConfigurationStartReason.Invalid);
        assert.match(error.message, /retired/);
    });
});
