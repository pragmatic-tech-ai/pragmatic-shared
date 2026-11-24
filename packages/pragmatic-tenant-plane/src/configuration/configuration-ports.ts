import type { ComponentDescriptor, SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import type { AppliedConfiguration, ApplyTarget } from '@pragmatic-tech-ai/pragmatic-configuration'

/** One deployment that runs a component: the name the console shows it by (its environment, or its namespace for the
 *  hive's own components), where it is, the descriptor its running image carries (undefined when it cannot be read:
 *  an image outside a reachable registry, such as a development image), and whether that image reads its applied
 *  configuration at start (false for a known component version from before its start step: an apply there would roll
 *  the pods and change nothing they run). */
export class ConfigurationTarget
{
    public constructor(
        public readonly Name: string,
        public readonly Target: ApplyTarget,
        public readonly DescriptorDigest: string | undefined,
        public readonly ComponentVersion: string | undefined,
        public readonly ReadsConfiguration: boolean = true,
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
    /** Whether an apply to `target` is still being proven outside this service's own in-flight applies (the console's own
     *  apply, proven by the console it restarted); such a target takes no new apply until it is settled. */
    Busy?(target: ApplyTarget): boolean
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

/** The target runs a component version that does not read its applied configuration at start (an image from before its
 *  start step), so an apply there would be recorded applied while nothing reads it. */
export class ConfigurationReadsNoConfigurationError extends Error
{
    public static readonly Code = 'component-reads-no-configuration'
    private static readonly ErrorName = 'ConfigurationReadsNoConfigurationError'
    private static readonly Prefix = 'The target runs'
    private static readonly Tail = 'which does not read its configuration at start; update the component there first.'

    public constructor(public readonly Component: string, public readonly ComponentVersion: string)
    {
        super(`${ConfigurationReadsNoConfigurationError.Prefix} ${Component} ${ComponentVersion}, ${ConfigurationReadsNoConfigurationError.Tail}`)
        this.name = ConfigurationReadsNoConfigurationError.ErrorName
    }

    public get Code(): string
    {
        return ConfigurationReadsNoConfigurationError.Code
    }
}

/** Another apply to the same target is still waiting for its roll. */
export class ConfigurationApplyInProgressError extends Error
{
    public static readonly Code = 'apply-in-progress'
    private static readonly ErrorName = 'ConfigurationApplyInProgressError'
    private static readonly Text = 'Another configuration is being applied to that target; wait for it to finish.'

    public constructor()
    {
        super(ConfigurationApplyInProgressError.Text)
        this.name = ConfigurationApplyInProgressError.ErrorName
    }
}

/** The cluster refused a secret write (its own text is not kept: it is not shown, and could echo what was sent). */
export class ConfigurationSecretWriteError extends Error
{
    private static readonly ErrorName = 'ConfigurationSecretWriteError'
    private static readonly Text = 'The cluster refused to store the secret.'

    public constructor()
    {
        super(ConfigurationSecretWriteError.Text)
        this.name = ConfigurationSecretWriteError.ErrorName
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

/** How a component's applied configuration stands for the descriptor a new release brings, at one target. */
export enum ConfigurationPreparationOutcome
{
    /** A version validated for that descriptor is prepared beside the applied one (the new pods read it). */
    Prepared = 'prepared',
    /** The applied document does not validate against that descriptor: the named settings must change first. */
    Refused = 'refused',
}

/** One preparation as the console lists it (settings and rules only, never a value). */
export type ConfigurationPreparationDto = {
    environment: string
    componentVersion: string
    descriptorDigest: string
    outcome: ConfigurationPreparationOutcome
    settings: string[]
    reason: string
}

/** What a target's pods run when it is a prepared entry rather than the applied file: the repository version of that
 *  entry, the component version it was prepared for, and the version of the applied file beside it. */
export type ConfigurationRunsDto = { version: number; componentVersion: string; appliedVersion: number }

/** Where the console reads how a component's configuration was prepared for new descriptors (the status it recorded on
 *  each target's `pragmatic-config-<component>` ConfigMap), and which of those entries a target's pods run. */
export interface IConfigurationPreparationSource
{
    For(component: string, targets: readonly ConfigurationTarget[]): Promise<readonly ConfigurationPreparationDto[]>
    /** The prepared entry the target's pods run (its running descriptor has one and the applied file is for another);
     *  undefined when they run the applied file, nothing, or what they run is not known. */
    Runs(component: string, target: ConfigurationTarget): Promise<ConfigurationRunsDto | undefined>
}

/** A console that prepares nothing (outside a cluster): no preparations to list. */
export class NoConfigurationPreparations implements IConfigurationPreparationSource
{
    public async For(): Promise<readonly ConfigurationPreparationDto[]>
    {
        return []
    }

    public async Runs(): Promise<ConfigurationRunsDto | undefined>
    {
        return undefined
    }
}
