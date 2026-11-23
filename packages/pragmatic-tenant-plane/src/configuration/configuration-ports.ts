import type { ComponentDescriptor, SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { AppliedConfiguration, ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'

/** One deployment that runs a component: the name the console shows it by (its environment, or its namespace for the
 *  hive's own components), where it is, and the descriptor its running image carries (undefined when it cannot be read:
 *  an image outside a reachable registry, such as a development image). */
export class ConfigurationTarget
{
    public constructor(
        public readonly Name: string,
        public readonly Target: ApplyTarget,
        public readonly DescriptorDigest: string | undefined,
        public readonly ComponentVersion: string | undefined,
    )
    {
        Object.freeze(this)
    }
}

/** Where a component's configuration can be applied: every deployment that runs it, in every namespace the console manages. */
export interface IConfigurationTargetSource
{
    For(component: string, tenantId: string): Promise<readonly ConfigurationTarget[]>
}

/**
 * The component descriptors a configuration is validated against. `Names` and `Current` are the components of the
 * console's own release (what it ships with, read without any registry); `For` finds the descriptor of one component
 * version, from the console's release or, for a version it does not ship, from the signed platform release that does
 * (DescriptorUnavailableError when that cannot be read; undefined when no adopted release has that version).
 */
export interface IComponentDescriptorSource
{
    Names(): readonly string[]
    Current(component: string): ComponentDescriptor | undefined
    For(component: string, componentVersion: string): Promise<ComponentDescriptor | undefined>
}

/** How a watched apply ended: the new pods became ready, or they did not and the previous configuration was restored. */
export enum ConfigurationApplyResult
{
    Applied = 'applied',
    Reverted = 'reverted',
}

/** Writes an applied configuration next to its deployment, rolls it and waits for the roll. */
export interface IConfigurationApplier
{
    /** Whether this console can write to its cluster at all (it runs in a pod). */
    readonly Available: boolean
    Apply(applied: AppliedConfiguration, target: ApplyTarget): Promise<ConfigurationApplyResult>
}

/** Writes a component's secret values where its secret store `file` reads them; answers the reference, never the value. */
export interface IComponentSecretWriter
{
    Put(component: string, name: string, value: string, targets: readonly ApplyTarget[]): Promise<SecretReference>
}

/** The console runs outside a cluster: there is nothing to write to. */
export class ConfigurationApplyUnavailableError extends Error
{
    private static readonly ErrorName = 'ConfigurationApplyUnavailableError'
    private static readonly Text = 'This console cannot reach its cluster, so a configuration cannot be applied here.'

    public constructor()
    {
        super(ConfigurationApplyUnavailableError.Text)
        this.name = ConfigurationApplyUnavailableError.ErrorName
    }
}

/** A descriptor the console needs could not be read (the release registry is unreachable or refused it). */
export class DescriptorUnavailableError extends Error
{
    public static readonly Code = 'descriptor-unavailable'
    private static readonly ErrorName = 'DescriptorUnavailableError'
    private static readonly Prefix = 'The descriptor of'
    private static readonly Tail = 'cannot be read from its platform release right now; try again later.'

    public constructor(public readonly Component: string, public readonly ComponentVersion: string)
    {
        super(`${DescriptorUnavailableError.Prefix} ${Component} ${ComponentVersion} ${DescriptorUnavailableError.Tail}`)
        this.name = DescriptorUnavailableError.ErrorName
    }
}

/** The target runs an image whose descriptor is not the one the version was validated against. */
export class ConfigurationDescriptorMismatchError extends Error
{
    public static readonly Code = 'descriptor-mismatch'
    private static readonly ErrorName = 'ConfigurationDescriptorMismatchError'
    private static readonly Prefix = 'The version was validated against descriptor'
    private static readonly Middle = 'but the target runs descriptor'
    private static readonly Tail = 'save a version for the component version it runs.'

    public constructor(public readonly Saved: string, public readonly Running: string)
    {
        super(ConfigurationDescriptorMismatchError.Text(Saved, Running))
        this.name = ConfigurationDescriptorMismatchError.ErrorName
    }

    private static Text(saved: string, running: string): string
    {
        const E = ConfigurationDescriptorMismatchError
        return `${E.Prefix} ${saved}, ${E.Middle} ${running}: ${E.Tail}`
    }
}

/** The applier of a console outside a cluster: every apply is refused. */
export class UnavailableConfigurationApplier implements IConfigurationApplier
{
    public get Available(): boolean
    {
        return false
    }

    public async Apply(): Promise<ConfigurationApplyResult>
    {
        throw new ConfigurationApplyUnavailableError()
    }
}

/** The secret writer of a console outside a cluster: every write is refused. */
export class UnavailableComponentSecretWriter implements IComponentSecretWriter
{
    public async Put(): Promise<SecretReference>
    {
        throw new ConfigurationApplyUnavailableError()
    }
}
