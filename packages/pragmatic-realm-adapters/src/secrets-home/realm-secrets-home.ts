import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import type { RealmSecretsOption } from './realm-secrets-option.js'
import type { RealmSecretsSettingRule, RealmSecretsSettings } from './realm-secrets-settings.js'
import { RealmSecretsSettingsError } from './realm-secrets-settings.js'
import type { WorkloadContext } from './workload-context.js'

/** One realm option's secrets home: the settings it takes and how it opens the realm's store for a workload. */
export interface IRealmSecretsHomeFactory
{
    readonly Option: RealmSecretsOption
    readonly Settings: readonly RealmSecretsSettingRule[]
    /** The realm's store for this workload. Opening does no I/O that can fail on the home's state: the first read or
     *  write reaches the home and fails typed (`SecretsHomeUnavailableError`). */
    Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<ISecretStore>
}

/**
 * The one place that turns a realm option into the realm's `ISecretStore`. Holds one factory per option, given by the
 * caller (each option's package exports its own; `pragmatic-configuration`'s `RealmSecretsHomes.Standard()` holds all
 * four), so no option's SDK is loaded by a package that does not use it.
 */
export class RealmSecretsHome
{
    private static readonly Duplicate = 'two realm secrets home factories for the option '
    private static readonly UnknownOption = 'no realm secrets home is available for the option '

    private readonly factories = new Map<RealmSecretsOption, IRealmSecretsHomeFactory>()

    public constructor(factories: readonly IRealmSecretsHomeFactory[])
    {
        for (const factory of factories)
        {
            if (this.factories.has(factory.Option)) throw new Error(RealmSecretsHome.Duplicate + factory.Option)
            this.factories.set(factory.Option, factory)
        }
    }

    public get Options(): readonly RealmSecretsOption[]
    {
        return [...this.factories.keys()]
    }

    /** The settings' option's rules; throws when no factory serves the option. */
    public RulesFor(option: RealmSecretsOption): readonly RealmSecretsSettingRule[]
    {
        return this.FactoryFor(option).Settings
    }

    /** The realm's secrets store for `context`, through the settings' option (validated first). */
    public async For(settings: RealmSecretsSettings, context: WorkloadContext): Promise<ISecretStore>
    {
        const factory = this.FactoryFor(settings.Option)
        return factory.Open(settings.Validated(factory.Settings), context)
    }

    private FactoryFor(option: RealmSecretsOption): IRealmSecretsHomeFactory
    {
        const factory = this.factories.get(option)
        if (factory === undefined) throw new RealmSecretsSettingsError(RealmSecretsHome.UnknownOption + option)
        return factory
    }
}
