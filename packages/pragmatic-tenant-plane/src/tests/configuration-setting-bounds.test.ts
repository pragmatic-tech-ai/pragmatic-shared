import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDeclarations, ConfigurationErrorCode, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget, InMemoryConfigurationRepository, type AppliedConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationService } from '../configuration/configuration-service.js'
import {
    ConfigurationApplyResult, ConfigurationTarget, UnavailableComponentSecretWriter, type IComponentDescriptorSource, type IConfigurationApplier,
    type IConfigurationTargetSource,
} from '../configuration/configuration-ports.js'

class BoundedCase
{
    public static readonly Component = 'pragmatic-env-server'
    public static readonly Tenant = 't1'
    public static readonly Version = '0.1.3'

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build({
            name: BoundedCase.Component, version: BoundedCase.Version, roles: [], postgres: false, ports: [],
            options: [{ name: 'core', description: 'core', settings: [
                { name: 'drainTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_DRAIN_MS', description: 'drain', minimum: 1, maximum: 25000, default: 10000 },
                { name: 'idleTtlMs', type: SettingType.Integer, source: 'PRAGMATIC_IDLE_TTL_MS', description: 'idle', minimum: 1000 },
            ] }],
        })
    }
}

class BoundedDescriptors implements IComponentDescriptorSource
{
    public Names(): readonly string[]
    {
        return [BoundedCase.Component]
    }

    public Current(): ComponentDescriptor
    {
        return BoundedCase.Descriptor()
    }

    public async For(): Promise<ComponentDescriptor>
    {
        return BoundedCase.Descriptor()
    }
}

class NoTargets implements IConfigurationTargetSource
{
    public async For(): Promise<readonly ConfigurationTarget[]>
    {
        return [new ConfigurationTarget('dev1', new ApplyTarget('h1', 'pragmatic-env-dev1', 'dev1-server'), undefined, undefined)]
    }
}

class IdleApplier implements IConfigurationApplier
{
    public Busy(): boolean
    {
        return false
    }

    public get Available(): boolean
    {
        return true
    }

    public async Apply(_applied: AppliedConfiguration, _target: ApplyTarget): Promise<ConfigurationApplyResult>
    {
        return ConfigurationApplyResult.Applied
    }
}

test('a version with a value outside a setting\'s declared minimum or maximum is refused at save time, by path; the component lists the bounds', async () =>
{
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new BoundedDescriptors(), new NoTargets(), new IdleApplier(), new UnavailableComponentSecretWriter())
    await assert.rejects(service.Save(BoundedCase.Tenant, BoundedCase.Component, 0, { options: { core: { drainTimeoutMs: 26000, idleTtlMs: 999 } } }, 'admin', 'c'), (err: unknown) =>
    {
        const errors = (err as { Errors?: readonly { Path: string; Code: string }[] }).Errors
        assert.ok(errors !== undefined, 'a validation error')
        assert.deepEqual(errors.map(e => [e.Path, e.Code]), [['/options/core/drainTimeoutMs', ConfigurationErrorCode.AboveMaximum], ['/options/core/idleTtlMs', ConfigurationErrorCode.BelowMinimum]])
        return true
    })
    const saved = await service.Save(BoundedCase.Tenant, BoundedCase.Component, 0, { options: { core: { drainTimeoutMs: 25000, idleTtlMs: 1000 } } }, 'admin', 'c')
    assert.equal(saved.version, 1)
    const settings = (await service.Component(BoundedCase.Tenant, BoundedCase.Component)).options[0]!.settings
    assert.deepEqual(settings.map(s => [s.name, s.minimum, s.maximum]), [['drainTimeoutMs', 1, 25000], ['idleTtlMs', 1000, undefined]])
    assert.equal('maximum' in settings[1]!, false)
})
