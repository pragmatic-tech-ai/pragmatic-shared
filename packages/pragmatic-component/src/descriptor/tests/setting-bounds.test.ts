import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ComponentDescriptorBuilder, type SettingBuilder } from '../component-descriptor-builder.js';
import { ComponentDescriptorCodec } from '../component-descriptor-codec.js';
import { ComponentDescriptorError } from '../component-descriptor-error.js';
import { ComponentDeclarations } from '../../declaration/component-declarations.js';
import { ConfigurationErrorCode } from '../../configuration/configuration-error.js';
import { ConfigurationSchema } from '../../configuration/configuration-schema.js';
import { ConfigurationValidator } from '../../configuration/configuration-validator.js';
import { SettingType } from '../setting-type.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

class Bounded
{
    public static readonly Shortest = 1000;
    public static readonly Longest = 25000;

    public static Descriptor(configure: (b: ComponentDescriptorBuilder) => ComponentDescriptorBuilder = b => b): ReturnType<ComponentDescriptorBuilder['Build']>
    {
        return configure(new ComponentDescriptorBuilder('bounded', '1.0.0')
            .Option('core', 'Core.', option => option
                .Setting('drainTimeoutMs', SettingType.Integer, s => s.Minimum(Bounded.Shortest).Maximum(Bounded.Longest).Default(5000))
                .Setting('idleTtlMs', SettingType.Integer, s => s.Minimum(Bounded.Shortest))
                .Setting('backlog', SettingType.Integer, s => s.Maximum(Bounded.Longest))
                .Setting('label', SettingType.String)))
            .Build();
    }

    public static Fails(build: () => unknown, pattern: RegExp): void
    {
        assert.throws(build, (error: unknown) => error instanceof ComponentDescriptorError && pattern.test(error.message));
    }

    public static Errors(document: unknown): [string, ConfigurationErrorCode][]
    {
        return new ConfigurationValidator(Bounded.Descriptor()).Validate(document).Errors.map(e => [e.Path, e.Code]);
    }
}

describe('Setting bounds (optional minimum and maximum of an integer setting)', () =>
{
    it('are carried by the descriptor and its JSON, only where declared', () =>
    {
        const descriptor = Bounded.Descriptor();
        const drain = descriptor.Option('core')!.Setting('drainTimeoutMs')!;
        assert.deepEqual([drain.Minimum, drain.Maximum], [1000, 25000]);
        assert.deepEqual([descriptor.Option('core')!.Setting('idleTtlMs')!.Minimum, descriptor.Option('core')!.Setting('idleTtlMs')!.Maximum], [1000, undefined]);
        const json = descriptor.ToJson() as { options: { settings: Record<string, unknown>[] }[] };
        assert.deepEqual(json.options[0]!.settings.map(s => [s.name, s.minimum, s.maximum]), [
            ['drainTimeoutMs', 1000, 25000], ['idleTtlMs', 1000, undefined], ['backlog', undefined, 25000], ['label', undefined, undefined],
        ]);
        assert.equal('minimum' in json.options[0]!.settings[3]!, false);
    });

    it('leave a descriptor without bounds as it was: no new members, so its digest and every deployed reader are unchanged', () =>
    {
        const text = ComponentDescriptorCodec.Serialize(RealmSignInDescriptor.Build());
        assert.doesNotMatch(text, /minimum|maximum/);
        assert.equal(ComponentDescriptorCodec.Parse(text).ContentDigest(), RealmSignInDescriptor.Build().ContentDigest());
    });

    it('round-trip through the codec to the same digest', () =>
    {
        const descriptor = Bounded.Descriptor();
        const decoded = ComponentDescriptorCodec.Parse(ComponentDescriptorCodec.Serialize(descriptor));
        assert.equal(decoded.ContentDigest(), descriptor.ContentDigest());
        assert.deepEqual([decoded.Option('core')!.Setting('backlog')!.Minimum, decoded.Option('core')!.Setting('backlog')!.Maximum], [undefined, 25000]);
        assert.notEqual(descriptor.ContentDigest(), new ComponentDescriptorBuilder('bounded', '1.0.0')
            .Option('core', 'Core.', option => option
                .Setting('drainTimeoutMs', SettingType.Integer, s => s.Default(5000))
                .Setting('idleTtlMs', SettingType.Integer)
                .Setting('backlog', SettingType.Integer)
                .Setting('label', SettingType.String))
            .Build().ContentDigest(), 'a bound is part of what the digest covers');
    });

    it('are refused on a setting that is not an integer, when not safe integers, and when the minimum is above the maximum or the default outside', () =>
    {
        const one = (configure: (s: SettingBuilder) => SettingBuilder, type: SettingType = SettingType.Integer) =>
            () => new ComponentDescriptorBuilder('c', '1.0.0').Option('o', '', option => option.Setting('s', type, configure)).Build();
        Bounded.Fails(one(s => s.Minimum(1), SettingType.String), /setting 'o\.s' is not an integer: it cannot have a minimum or maximum/);
        Bounded.Fails(one(s => s.Maximum(1), SettingType.Duration), /setting 'o\.s' is not an integer/);
        Bounded.Fails(one(s => s.Minimum(1.5)), /minimum of setting 'o\.s' is not a safe integer/);
        Bounded.Fails(one(s => s.Maximum(Number.MAX_SAFE_INTEGER + 1)), /maximum of setting 'o\.s' is not a safe integer/);
        Bounded.Fails(one(s => s.Minimum(10).Maximum(9)), /setting 'o\.s' has a minimum above its maximum/);
        Bounded.Fails(one(s => s.Minimum(10).Default(9)), /default of setting 'o\.s' is outside its minimum and maximum/);
        Bounded.Fails(one(s => s.Maximum(10).Default(11)), /default of setting 'o\.s' is outside its minimum and maximum/);
        assert.doesNotThrow(one(s => s.Minimum(10).Maximum(10).Default(10)));
    });

    it('decoded: a wrongly typed bound is refused, and the builder rules apply', () =>
    {
        const json = JSON.parse(ComponentDescriptorCodec.Serialize(Bounded.Descriptor())) as { options: { settings: Record<string, unknown>[] }[] };
        json.options[0]!.settings[0]!.minimum = '1000';
        assert.throws(() => ComponentDescriptorCodec.Decode(json), (e: unknown) => e instanceof ComponentDescriptorError);
        json.options[0]!.settings[0]!.minimum = 30000;
        assert.throws(() => ComponentDescriptorCodec.Decode(json), (e: unknown) => e instanceof ComponentDescriptorError && /minimum above its maximum/.test(e.message));
    });

    it('a value below the minimum or above the maximum is refused at validation, by path, with a fixed message (never the value)', () =>
    {
        assert.deepEqual(Bounded.Errors({ options: { core: { drainTimeoutMs: 999, idleTtlMs: 1000, backlog: 25001 } } }), [
            ['/options/core/drainTimeoutMs', ConfigurationErrorCode.BelowMinimum],
            ['/options/core/backlog', ConfigurationErrorCode.AboveMaximum],
        ]);
        assert.deepEqual(Bounded.Errors({ options: { core: { drainTimeoutMs: 25000, idleTtlMs: 2147483647, backlog: -5 } } }), []);
        const [error] = new ConfigurationValidator(Bounded.Descriptor()).Validate({ options: { core: { drainTimeoutMs: 26000 } } }).Errors;
        assert.equal(error!.toString(), '/options/core/drainTimeoutMs is above the largest value this setting accepts');
        assert.equal(new ConfigurationValidator(Bounded.Descriptor()).Validate({ options: { core: { drainTimeoutMs: 1 } } }).Errors[0]!.Message, 'is below the smallest value this setting accepts');
    });

    it('come from a declaration (`minimum`, `maximum`)', () =>
    {
        const descriptor = ComponentDeclarations.Build({
            name: 'declared', version: '1.0.0', roles: [], postgres: false, ports: [],
            options: [{ name: 'core', description: '', settings: [{ name: 'drainTimeoutMs', type: SettingType.Integer, source: 'DRAIN_MS', description: 'Drain.', minimum: 1, maximum: 25000, default: 5000 }] }],
        });
        const setting = descriptor.Option('core')!.Setting('drainTimeoutMs')!;
        assert.deepEqual([setting.Minimum, setting.Maximum, setting.Default], [1, 25000, 5000]);
    });

    it('are stated in the JSON Schema as minimum and maximum', () =>
    {
        const schema = new ConfigurationSchema(Bounded.Descriptor()).ToJson() as { properties: { options: { properties: { core: { properties: Record<string, Record<string, unknown>> } } } } };
        const settings = schema.properties.options.properties.core.properties;
        assert.deepEqual([settings.drainTimeoutMs!.minimum, settings.drainTimeoutMs!.maximum], [1000, 25000]);
        assert.equal('maximum' in settings.idleTtlMs!, false);
        assert.equal('minimum' in settings.label!, false);
    });
});
