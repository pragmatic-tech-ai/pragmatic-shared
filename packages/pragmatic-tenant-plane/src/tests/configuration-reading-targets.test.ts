import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDeclarations, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget, InMemoryConfigurationRepository, type AppliedConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationService } from '../configuration/configuration-service.js'
import {
    ConfigurationApplyInProgressError, ConfigurationApplyResult, ConfigurationReadsNoConfigurationError, ConfigurationTarget, NoConfigurationPreparations, UnavailableComponentSecretWriter,
    type ConfigurationPreparationDto, type ConfigurationRunsDto, type IComponentDescriptorSource, type IConfigurationApplier, type IConfigurationPreparationSource,
    type IConfigurationTargetSource,
} from '../configuration/configuration-ports.js'

class ReadingCase
{
    public static readonly Component = 'pragmatic-env-server'
    public static readonly Tenant = 't1'
    public static readonly Old = '0.1.0'

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build({
            name: ReadingCase.Component, version: ReadingCase.Old, roles: [], postgres: false, ports: [],
            options: [{ name: 'core', description: 'core', settings: [{ name: 'drainMs', type: SettingType.Integer, source: 'PRAGMATIC_DRAIN_MS', description: 'drain' }] }],
        })
    }

    public static Target(reads: boolean): ConfigurationTarget
    {
        return new ConfigurationTarget('dev1', new ApplyTarget('h1', 'pragmatic-env-dev1', 'dev1-server'), ReadingCase.Descriptor().ContentDigest(), ReadingCase.Old, reads)
    }
}

class OldDescriptor implements IComponentDescriptorSource
{
    public Names(): readonly string[]
    {
        return [ReadingCase.Component]
    }

    public Current(): ComponentDescriptor
    {
        return ReadingCase.Descriptor()
    }

    public async For(): Promise<ComponentDescriptor>
    {
        return ReadingCase.Descriptor()
    }
}

class FixedTargets implements IConfigurationTargetSource
{
    public constructor(private readonly target: ConfigurationTarget)
    {
    }

    public async For(): Promise<readonly ConfigurationTarget[]>
    {
        return [this.target]
    }
}

class CountingApplier implements IConfigurationApplier
{
    public Applied = 0
    public BusyTargets: ApplyTarget[] = []

    public Busy(target: ApplyTarget): boolean
    {
        return this.BusyTargets.some(t => t.Equals(target))
    }

    public get Available(): boolean
    {
        return true
    }

    public async Apply(_applied: AppliedConfiguration, _target: ApplyTarget): Promise<ConfigurationApplyResult>
    {
        this.Applied += 1
        return ConfigurationApplyResult.Applied
    }
}

class RunsFromEntry implements IConfigurationPreparationSource
{
    public async For(): Promise<readonly ConfigurationPreparationDto[]>
    {
        return []
    }

    public async Runs(): Promise<ConfigurationRunsDto | undefined>
    {
        return { version: 2, componentVersion: '0.2.5', appliedVersion: 3 }
    }
}

test('an apply to a target whose image reads no configuration is refused before anything is recorded, naming the version', async () =>
{
    const repository = new InMemoryConfigurationRepository()
    const applier = new CountingApplier()
    const service = new ConfigurationService(repository, new OldDescriptor(), new FixedTargets(ReadingCase.Target(false)), applier, new UnavailableComponentSecretWriter())
    const saved = await service.Save(ReadingCase.Tenant, ReadingCase.Component, 0, { options: { core: { drainMs: 5 } } }, 'admin', 'c')
    await assert.rejects(service.Apply(ReadingCase.Tenant, ReadingCase.Component, saved.version, 'dev1', 'admin'), (err: unknown) =>
    {
        assert.ok(err instanceof ConfigurationReadsNoConfigurationError)
        assert.equal(err.Code, 'component-reads-no-configuration')
        assert.equal(ConfigurationReadsNoConfigurationError.Code, 'component-reads-no-configuration')
        assert.match(err.message, /pragmatic-env-server 0\.1\.0/)
        return true
    })
    assert.equal(applier.Applied, 0)
    assert.deepEqual((await service.Component(ReadingCase.Tenant, ReadingCase.Component)).applies, [])
    await assert.rejects(service.PutSecret(ReadingCase.Tenant, ReadingCase.Component, 'dev1', 'key', 'value'), ConfigurationReadsNoConfigurationError)
})

test('a target that reads its configuration is applied, and the list says which targets read one', async () =>
{
    const applier = new CountingApplier()
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new OldDescriptor(), new FixedTargets(ReadingCase.Target(true)), applier, new UnavailableComponentSecretWriter())
    const saved = await service.Save(ReadingCase.Tenant, ReadingCase.Component, 0, { options: { core: { drainMs: 5 } } }, 'admin', 'c')
    await service.Apply(ReadingCase.Tenant, ReadingCase.Component, saved.version, 'dev1', 'admin')
    assert.equal(applier.Applied, 1)
    const [summary] = await service.List(ReadingCase.Tenant)
    assert.equal(summary.targets[0].readsConfiguration, true)
    const refused = new ConfigurationService(new InMemoryConfigurationRepository(), new OldDescriptor(), new FixedTargets(ReadingCase.Target(false)), applier, new UnavailableComponentSecretWriter())
    assert.equal((await refused.List(ReadingCase.Tenant))[0].targets[0].readsConfiguration, false)
})

test('a target found without saying whether it reads configuration is taken to read it (development images, unverified targets)', () =>
{
    const target = new ConfigurationTarget('dev1', new ApplyTarget('h1', 'ns', 'd'), undefined, undefined)
    assert.equal(target.ReadsConfiguration, true)
})

test('the list says what a target runs when its pods run a prepared entry, not the applied file', async () =>
{
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new OldDescriptor(), new FixedTargets(ReadingCase.Target(true)), new CountingApplier(), new UnavailableComponentSecretWriter(), new RunsFromEntry())
    const [summary] = await service.List(ReadingCase.Tenant)
    assert.deepEqual(summary.targets[0].runs, { version: 2, componentVersion: '0.2.5', appliedVersion: 3 })
    const plain = new ConfigurationService(new InMemoryConfigurationRepository(), new OldDescriptor(), new FixedTargets(ReadingCase.Target(true)), new CountingApplier(), new UnavailableComponentSecretWriter(), new NoConfigurationPreparations())
    assert.equal((await plain.List(ReadingCase.Tenant))[0].targets[0].runs, null)
})

test('an apply to a target the applier is still proving (the console restarted by its own apply) is refused before anything is recorded', async () =>
{
    const applier = new CountingApplier()
    const target = ReadingCase.Target(true)
    applier.BusyTargets.push(target.Target)
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new OldDescriptor(), new FixedTargets(target), applier, new UnavailableComponentSecretWriter())
    const saved = await service.Save(ReadingCase.Tenant, ReadingCase.Component, 0, { options: { core: { drainMs: 5 } } }, 'admin', 'c')
    await assert.rejects(service.Apply(ReadingCase.Tenant, ReadingCase.Component, saved.version, 'dev1', 'admin'), ConfigurationApplyInProgressError)
    assert.equal(applier.Applied, 0)
    assert.deepEqual((await service.Component(ReadingCase.Tenant, ReadingCase.Component)).applies, [])
    applier.BusyTargets = []
    await service.Apply(ReadingCase.Tenant, ReadingCase.Component, saved.version, 'dev1', 'admin')
    assert.equal(applier.Applied, 1)
})
