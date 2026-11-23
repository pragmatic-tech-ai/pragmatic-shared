import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppliedConfiguration } from '../applied-configuration.js';
import { AppliedConfigurationCodec } from '../applied-configuration-codec.js';
import { AppliedConfigurationEntries } from '../applied-configuration-entries.js';
import { AppliedConfigurationError } from '../applied-configuration-error.js';
import { AppliedConfigurationKeys } from '../applied-configuration-keys.js';
import { ConfigurationPreparationRefusal, ConfigurationPreparationStatus } from '../configuration-preparation-status.js';

class EntriesCase
{
    public static readonly OldDigest = `sha256:${'a'.repeat(64)}`;
    public static readonly NewDigest = `sha256:${'b'.repeat(64)}`;
    public static readonly OtherDigest = `sha256:${'c'.repeat(64)}`;

    public static Applied(version: number, componentVersion: string, digest: string, realm = 'realm-acme'): AppliedConfiguration
    {
        return new AppliedConfiguration(realm, 'pragmatic-tenant-idp', version, componentVersion, digest, { options: { local: { maxAttempts: 5 } } });
    }
}

test('a prepared entry key is configuration.json.sha256-<hex> and never ends in .json', () =>
{
    const key = AppliedConfigurationEntries.KeyOf(EntriesCase.NewDigest);
    assert.equal(key, `configuration.json.sha256-${'b'.repeat(64)}`);
    assert.equal(key.endsWith('.json'), false);
    assert.equal(AppliedConfigurationEntries.DigestOfKey(key), EntriesCase.NewDigest);
    assert.equal(AppliedConfigurationEntries.DigestOfKey(AppliedConfigurationKeys.FileName), undefined);
    assert.equal(AppliedConfigurationEntries.DigestOfKey('previous.json'), undefined);
    assert.equal(AppliedConfigurationEntries.PathOf('/etc/pragmatic/configuration/configuration.json', EntriesCase.NewDigest), `/etc/pragmatic/configuration/${key}`);
    assert.throws(() => AppliedConfigurationEntries.KeyOf('sha256:short'), AppliedConfigurationError);
});

test('With adds the entry beside configuration.json and leaves the applied file and its hash annotation as they were', () =>
{
    const current = EntriesCase.Applied(3, '0.2.0', EntriesCase.OldDigest);
    const configMap = AppliedConfigurationCodec.ToConfigMap(current, 'pragmatic-idp-t1');
    const prepared = EntriesCase.Applied(4, '0.2.4', EntriesCase.NewDigest);
    const written = AppliedConfigurationEntries.With(configMap, prepared);
    assert.equal(written.data[AppliedConfigurationKeys.FileName], configMap.data[AppliedConfigurationKeys.FileName]);
    assert.equal(written.metadata.annotations[AppliedConfigurationKeys.HashAnnotation], current.ContentHash());
    assert.equal(written.data[AppliedConfigurationEntries.KeyOf(EntriesCase.NewDigest)], prepared.ToCanonicalJson());
    assert.equal(written.metadata.annotations[AppliedConfigurationKeys.PreparedDigestsAnnotation], EntriesCase.NewDigest);
    // The applied file still reads back (the old reader's view), and the original object is untouched.
    assert.equal(AppliedConfigurationCodec.FromConfigMap(written).Version, 3);
    assert.equal(Object.keys(configMap.data).length, 1);
});

test('Prepared reads every entry by digest and refuses one whose content names another descriptor than its key', () =>
{
    const configMap = AppliedConfigurationCodec.ToConfigMap(EntriesCase.Applied(3, '0.2.0', EntriesCase.OldDigest), 'ns');
    const written = AppliedConfigurationEntries.With(configMap, EntriesCase.Applied(4, '0.2.4', EntriesCase.NewDigest));
    const entries = AppliedConfigurationEntries.Prepared(written);
    assert.deepEqual([...entries.keys()], [EntriesCase.NewDigest]);
    assert.equal(entries.get(EntriesCase.NewDigest)?.Version, 4);
    const forged = structuredClone(written);
    forged.data[AppliedConfigurationEntries.KeyOf(EntriesCase.OtherDigest)] = EntriesCase.Applied(5, '0.2.5', EntriesCase.NewDigest).ToCanonicalJson();
    assert.throws(() => AppliedConfigurationEntries.Prepared(forged), AppliedConfigurationError);
    assert.equal(AppliedConfigurationEntries.Prepared({ data: { 'configuration.json': '{}' } }).size, 0);
});

test('Without drops the entries of the given digests and their prepared marks', () =>
{
    const configMap = AppliedConfigurationCodec.ToConfigMap(EntriesCase.Applied(3, '0.2.0', EntriesCase.OldDigest), 'ns');
    const two = AppliedConfigurationEntries.With(AppliedConfigurationEntries.With(configMap, EntriesCase.Applied(4, '0.2.4', EntriesCase.NewDigest)), EntriesCase.Applied(5, '0.2.5', EntriesCase.OtherDigest));
    assert.equal(two.metadata.annotations[AppliedConfigurationKeys.PreparedDigestsAnnotation], `${EntriesCase.NewDigest},${EntriesCase.OtherDigest}`);
    const one = AppliedConfigurationEntries.Without(two, [EntriesCase.NewDigest]);
    assert.deepEqual([...AppliedConfigurationEntries.Prepared(one).keys()], [EntriesCase.OtherDigest]);
    assert.equal(one.metadata.annotations[AppliedConfigurationKeys.PreparedDigestsAnnotation], EntriesCase.OtherDigest);
    const none = AppliedConfigurationEntries.Without(one, [EntriesCase.OtherDigest]);
    assert.equal(AppliedConfigurationKeys.PreparedDigestsAnnotation in none.metadata.annotations, false);
});

test('the preparation status round-trips its annotations; a refusal replaces a prepared mark and the reverse', () =>
{
    const refusal = new ConfigurationPreparationRefusal(EntriesCase.NewDigest, '0.2.4', ['core.databaseUrl'], 'core.databaseUrl is not a setting of this option');
    const refused = ConfigurationPreparationStatus.Empty.WithPrepared(EntriesCase.NewDigest).WithRefusal(refusal);
    assert.equal(refused.IsPrepared(EntriesCase.NewDigest), false);
    const read = ConfigurationPreparationStatus.Of(refused.ToAnnotations());
    assert.deepEqual(read.RefusalFor(EntriesCase.NewDigest)?.Settings, ['core.databaseUrl']);
    assert.equal(read.RefusalFor(EntriesCase.NewDigest)?.ComponentVersion, '0.2.4');
    const prepared = read.WithPrepared(EntriesCase.NewDigest);
    assert.equal(prepared.RefusalFor(EntriesCase.NewDigest), undefined);
    assert.deepEqual(prepared.ToAnnotations(), { [AppliedConfigurationKeys.PreparedDigestsAnnotation]: EntriesCase.NewDigest });
    assert.deepEqual(ConfigurationPreparationStatus.Empty.ToAnnotations(), {});
});

test('an unreadable preparation annotation reads as no status, never as a throw', () =>
{
    const status = ConfigurationPreparationStatus.Of({ [AppliedConfigurationKeys.PreparationRefusedAnnotation]: 'not json', [AppliedConfigurationKeys.PreparedDigestsAnnotation]: 'sha256:short,' + EntriesCase.NewDigest });
    assert.equal(status.Refusals.length, 0);
    assert.deepEqual(status.Prepared, [EntriesCase.NewDigest]);
    assert.equal(ConfigurationPreparationStatus.Of(undefined).Prepared.length, 0);
});
