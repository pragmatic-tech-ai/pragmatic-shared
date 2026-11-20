import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryConfigurationRepository } from '../../repository/in-memory-configuration-repository.js';
import { ConfigurationFixtures, TestClock } from '../../tests/fixtures/configuration-fixtures.js';
import { AppliedConfiguration } from '../applied-configuration.js';
import { AppliedConfigurationCodec } from '../applied-configuration-codec.js';
import { AppliedConfigurationError } from '../applied-configuration-error.js';

class AppliedFixture
{
    public static async Applied(passwordMinLength = 14): Promise<AppliedConfiguration>
    {
        const repository = new InMemoryConfigurationRepository(new TestClock());
        const scope = ConfigurationFixtures.Scope();
        const version = await repository.Save(ConfigurationFixtures.Save(scope, 0, ConfigurationFixtures.Document(passwordMinLength)));
        return AppliedConfiguration.From(version, ConfigurationFixtures.Descriptor());
    }
}

test('the applied form carries the resolved document (defaults filled, secrets as references) and the descriptor digest', async () =>
{
    const applied = await AppliedFixture.Applied();
    assert.equal(applied.Component, ConfigurationFixtures.Component);
    assert.equal(applied.Version, 1);
    assert.equal(applied.ComponentVersion, '0.3.0');
    assert.equal(applied.DescriptorDigest, ConfigurationFixtures.Descriptor().ContentDigest());
    assert.deepEqual(applied.Document, {
        options: {
            local: { selfRegistration: false, passwordMinLength: 14 },
            google: { clientId: 'client-1', clientSecret: ConfigurationFixtures.SecretReferenceText, allowedDomains: ['example.com'] },
        },
    });
    assert.equal(applied.ObjectName(), 'pragmatic-config-realm-sign-in');
    assert.match(applied.ContentHash(), /^sha256:[0-9a-f]{64}$/);
});

test('the applied form refuses a descriptor other than the one the version was validated against', async () =>
{
    const repository = new InMemoryConfigurationRepository(new TestClock());
    const version = await repository.Save(ConfigurationFixtures.Save(ConfigurationFixtures.Scope(), 0));
    assert.throws(() => AppliedConfiguration.From(version, ConfigurationFixtures.Descriptor('0.4.0')), AppliedConfigurationError);
});

test('the content hash changes with the document and is stable for the same content', async () =>
{
    const first = await AppliedFixture.Applied(14);
    const again = AppliedConfigurationCodec.Decode(AppliedConfigurationCodec.Encode(first));
    const other = await AppliedFixture.Applied(15);
    assert.equal(again.ContentHash(), first.ContentHash());
    assert.notEqual(other.ContentHash(), first.ContentHash());
    const moved = new AppliedConfiguration(first.Realm, first.Component, first.Version, first.ComponentVersion, first.DescriptorDigest, other.Document);
    assert.notEqual(moved.ContentHash(), first.ContentHash());
});

test('the ConfigMap is named for the component, carries the file, and annotates version, digest and hash', async () =>
{
    const applied = await AppliedFixture.Applied();
    const configMap = AppliedConfigurationCodec.ToConfigMap(applied, 'realm-a');
    assert.equal(configMap.apiVersion, 'v1');
    assert.equal(configMap.kind, 'ConfigMap');
    assert.equal(configMap.metadata.name, 'pragmatic-config-realm-sign-in');
    assert.equal(configMap.metadata.namespace, 'realm-a');
    assert.deepEqual(configMap.metadata.labels, { 'app.kubernetes.io/component': 'realm-sign-in', 'app.kubernetes.io/managed-by': 'pragmatic-tenant-admin' });
    assert.deepEqual(configMap.metadata.annotations, {
        'pragmatic-tech.ai/configuration-version': '1',
        'pragmatic-tech.ai/descriptor-digest': applied.DescriptorDigest,
        'pragmatic-tech.ai/configuration-hash': applied.ContentHash(),
        'pragmatic-tech.ai/realm': applied.Realm,
    });
    assert.deepEqual(Object.keys(configMap.data), ['configuration.json']);
    assert.equal(configMap.data['configuration.json'], applied.ToCanonicalJson());
    assert.ok(!JSON.stringify(configMap).includes(ConfigurationFixtures.SecretValue));
    assert.deepEqual(AppliedConfigurationCodec.PodTemplateAnnotations(applied), { 'pragmatic-tech.ai/configuration-hash': applied.ContentHash() });
    const back = AppliedConfigurationCodec.FromConfigMap(JSON.parse(JSON.stringify(configMap)));
    assert.equal(back.ContentHash(), applied.ContentHash());
});

test('FromConfigMap refuses another kind, a missing file, a renamed object or a hash that does not match', async () =>
{
    const applied = await AppliedFixture.Applied();
    const good = (): ReturnType<typeof AppliedConfigurationCodec.ToConfigMap> => JSON.parse(JSON.stringify(AppliedConfigurationCodec.ToConfigMap(applied, 'realm-a')));
    const secret = good();
    (secret as { kind: string }).kind = 'Secret';
    assert.throws(() => AppliedConfigurationCodec.FromConfigMap(secret), AppliedConfigurationError);
    const empty = good();
    empty.data = {};
    assert.throws(() => AppliedConfigurationCodec.FromConfigMap(empty), AppliedConfigurationError);
    const renamed = good();
    renamed.metadata.name = 'pragmatic-config-other';
    assert.throws(() => AppliedConfigurationCodec.FromConfigMap(renamed), AppliedConfigurationError);
    const tampered = good();
    tampered.metadata.annotations['pragmatic-tech.ai/configuration-hash'] = 'sha256:' + '0'.repeat(64);
    assert.throws(() => AppliedConfigurationCodec.FromConfigMap(tampered), AppliedConfigurationError);
    assert.throws(() => AppliedConfigurationCodec.FromConfigMap(null), AppliedConfigurationError);
});

test('Decode is strict: JSON, the known members only, schema 1, well-formed values; errors never echo values', async () =>
{
    const json = (await AppliedFixture.Applied()).ToJson();
    const variants: Record<string, unknown>[] = [
        { ...json, extra: 1 },
        { ...json, schema: 2 },
        { ...json, version: 0 },
        { ...json, version: '1' },
        { ...json, component: 'Realm Sign In' },
        { ...json, realm: '' },
        { ...json, componentVersion: '' },
        { ...json, descriptorDigest: 'sha256:abc' },
        { ...json, document: ['options'] },
    ];
    for (const variant of variants)
    {
        assert.throws(() => AppliedConfigurationCodec.Decode(JSON.stringify(variant)), AppliedConfigurationError, JSON.stringify(variant));
    }
    const { realm: _realm, ...missing } = json;
    assert.throws(() => AppliedConfigurationCodec.Decode(JSON.stringify(missing)), AppliedConfigurationError);
    assert.throws(() => AppliedConfigurationCodec.Decode('{not json'), AppliedConfigurationError);
    assert.throws(() => AppliedConfigurationCodec.Decode(JSON.stringify({ ...json, realm: 'secret-value-xyz!' })), (error: unknown) =>
        error instanceof AppliedConfigurationError && !error.message.includes('secret-value-xyz'));
});
