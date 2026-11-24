import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentDeclarations, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ApplyTarget, InMemoryConfigurationRepository } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationService } from '../configuration/configuration-service.js'
import {
    ConfigurationPreparationOutcome, ConfigurationTarget, UnavailableComponentSecretWriter, UnavailableConfigurationApplier,
    type ConfigurationPreparationDto, type ConfigurationRunsDto, type IComponentDescriptorSource, type IConfigurationPreparationSource, type IConfigurationTargetSource,
} from '../configuration/configuration-ports.js'

class PreparationCase
{
    public static readonly Component = 'pragmatic-tenant-idp'
    public static readonly Tenant = 't1'

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build({ name: PreparationCase.Component, version: '0.2.4', options: [], roles: [], postgres: false, ports: [] })
    }

    public static Target(): ConfigurationTarget
    {
        return new ConfigurationTarget('pragmatic-idp-t1', new ApplyTarget('h1', 'pragmatic-idp-t1', 'pragmatic-idp-t1'), undefined, undefined)
    }
}

class OneDescriptor implements IComponentDescriptorSource
{
    public Names(): readonly string[]
    {
        return [PreparationCase.Component]
    }

    public Current(): ComponentDescriptor
    {
        return PreparationCase.Descriptor()
    }

    public async For(): Promise<ComponentDescriptor>
    {
        return PreparationCase.Descriptor()
    }
}

class OneTarget implements IConfigurationTargetSource
{
    public async For(): Promise<readonly ConfigurationTarget[]>
    {
        return [PreparationCase.Target()]
    }
}

class RecordedPreparations implements IConfigurationPreparationSource
{
    public readonly Asked: { component: string; targets: number }[] = []

    public async For(component: string, targets: readonly ConfigurationTarget[]): Promise<readonly ConfigurationPreparationDto[]>
    {
        this.Asked.push({ component, targets: targets.length })
        return [{ environment: 'pragmatic-idp-t1', componentVersion: '0.2.4', descriptorDigest: `sha256:${'b'.repeat(64)}`, outcome: ConfigurationPreparationOutcome.Refused, settings: ['core.databaseUrl'], reason: 'core.databaseUrl is not a setting of this option' }]
    }

    public async Runs(): Promise<ConfigurationRunsDto | undefined>
    {
        return undefined
    }
}

test('a component page lists how its configuration was prepared for new descriptors, from the targets it found', async () =>
{
    const preparations = new RecordedPreparations()
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new OneDescriptor(), new OneTarget(), new UnavailableConfigurationApplier(), new UnavailableComponentSecretWriter(), preparations)
    const page = await service.Component(PreparationCase.Tenant, PreparationCase.Component)
    assert.deepEqual(preparations.Asked, [{ component: PreparationCase.Component, targets: 1 }])
    assert.equal(page.preparations.length, 1)
    assert.equal(page.preparations[0].outcome, ConfigurationPreparationOutcome.Refused)
    assert.deepEqual(page.preparations[0].settings, ['core.databaseUrl'])
})

test('without a preparation source a component page lists none', async () =>
{
    const service = new ConfigurationService(new InMemoryConfigurationRepository(), new OneDescriptor(), new OneTarget(), new UnavailableConfigurationApplier(), new UnavailableComponentSecretWriter())
    assert.deepEqual((await service.Component(PreparationCase.Tenant, PreparationCase.Component)).preparations, [])
})
