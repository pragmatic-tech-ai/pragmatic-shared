import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentDescriptorBuilder, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedDocumentCarryOver } from '../applied-document-carry-over.js';
import { AppliedConfigurationKeys } from '../applied-configuration-keys.js';
import { ConfigurationPreparationRefusal, ConfigurationPreparationStatus } from '../configuration-preparation-status.js';

class CarryCase
{
    public static readonly HashA = `sha256:${'1'.repeat(64)}`;
    public static readonly HashB = `sha256:${'2'.repeat(64)}`;
    public static readonly Digest = `sha256:${'3'.repeat(64)}`;

    public static Old(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder('pragmatic-test', '0.1.0')
            .Option('core', 'Core', o => o.Setting('databaseUrl', SettingType.String, s => s.Default('postgres://localhost/x')).Setting('port', SettingType.Integer, s => s.Default(80)))
            .Option('legacy', 'Gone in 0.2.0', o => o.Setting('mode', SettingType.String, s => s.Default('on')))
            .Build();
    }

    public static New(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder('pragmatic-test', '0.2.0')
            .Option('core', 'Core', o => o.Setting('port', SettingType.Integer, s => s.Default(80)))
            .Build();
    }
}

test('with the inherited descriptor, only the defaults it filled in are left behind; a value an admin set is kept', () =>
{
    const inheritedOnly = AppliedDocumentCarryOver.Carry({ options: { core: { databaseUrl: 'postgres://localhost/x', port: 8080 }, legacy: { mode: 'on' } } }, CarryCase.New(), CarryCase.Old());
    assert.deepEqual(inheritedOnly.Document, { options: { core: { port: 8080 } } });
    assert.deepEqual(inheritedOnly.Dropped, ['core.databaseUrl', 'legacy']);
    const set = AppliedDocumentCarryOver.Carry({ options: { core: { databaseUrl: 'postgres://elsewhere/x' }, legacy: { mode: 'off' } } }, CarryCase.New(), CarryCase.Old());
    assert.deepEqual(set.Document, { options: { core: { databaseUrl: 'postgres://elsewhere/x' }, legacy: { mode: 'off' } } });
    assert.deepEqual(set.Dropped, []);
});

test('without the inherited descriptor every undeclared member is left behind, and declared ones never change', () =>
{
    const carried = AppliedDocumentCarryOver.Carry({ options: { core: { databaseUrl: 'postgres://elsewhere/x', port: 'not-a-port' }, legacy: { mode: 'off' } } }, CarryCase.New());
    assert.deepEqual(carried.Document, { options: { core: { port: 'not-a-port' } } });
    assert.deepEqual(carried.Dropped, ['core.databaseUrl', 'legacy']);
    assert.deepEqual(AppliedDocumentCarryOver.Carry('not a document', CarryCase.New()).Document, 'not a document');
});

test('a preparation status holds only for the applied file it was derived from', () =>
{
    const refusal = new ConfigurationPreparationRefusal(CarryCase.Digest, '0.2.0', ['core.x'], 'r');
    const status = ConfigurationPreparationStatus.Empty.DerivedFrom(CarryCase.HashA).WithRefusal(refusal);
    const read = ConfigurationPreparationStatus.Of(status.ToAnnotations());
    assert.equal(read.From, CarryCase.HashA);
    assert.ok(read.Holds(CarryCase.HashA));
    assert.equal(read.Holds(CarryCase.HashB), false);
    assert.equal(read.Holds(undefined), false);
    const stale = read.DerivedFrom(CarryCase.HashB);
    assert.equal(stale.Refusals.length, 0, 'what was derived from another file is dropped');
    assert.equal(stale.From, CarryCase.HashB);
    assert.equal(read.DerivedFrom(CarryCase.HashA), read);
    assert.deepEqual(stale.ToAnnotations(), { [AppliedConfigurationKeys.PreparedFromAnnotation]: CarryCase.HashB }, 'an empty derived status writes its source alone');
    assert.equal(AppliedConfigurationKeys.PreparedFromAnnotation in read.Over({ [AppliedConfigurationKeys.PreparedFromAnnotation]: CarryCase.HashA, other: 'x' }), true);
    assert.deepEqual(ConfigurationPreparationStatus.Empty.Over({ [AppliedConfigurationKeys.PreparedFromAnnotation]: CarryCase.HashA, other: 'x' }), { other: 'x' });
});
