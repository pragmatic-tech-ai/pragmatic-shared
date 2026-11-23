import type { ComponentDescriptor, SecretReference } from '@pragmatic-tech-ai/pragmatic-component'
import {
    AppliedConfiguration,
    ApplyOutcome,
    ApplyRequest,
    ConfigurationSaveRequest,
    ConfigurationScope,
    type ApplyRecord,
    type ConfigurationVersion,
    type IConfigurationRepository,
} from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationDiff, type ConfigurationChange } from './configuration-diff.js'
import {
    ConfigurationApplyInProgressError,
    ConfigurationApplyResult,
    ConfigurationApplyUnavailableError,
    ConfigurationSecretWriteError,
    ConfigurationDescriptorMismatchError,
    type ConfigurationTarget,
    type IComponentDescriptorSource,
    type IComponentSecretWriter,
    type IConfigurationApplier,
    type IConfigurationTargetSource,
} from './configuration-ports.js'

/** One target of a component as the console lists it: its name (environment or namespace), where it is, and what runs there. */
export type ConfigurationTargetDto = { environment: string; hive: string; namespace: string; deployment: string; componentVersion: string | null; descriptorDigest: string | null }

/** One saved version as the console lists it (no document). */
export type ConfigurationVersionSummaryDto = { version: number; componentVersion: string; descriptorDigest: string; author: string; createdAt: string; comment: string }

/** One saved version with its document as authored. */
export type ConfigurationVersionDto = ConfigurationVersionSummaryDto & { document: unknown }

/** One apply as the console lists it. */
export type ConfigurationApplyDto = { id: number; version: number; environment: string; outcome: string; requestedBy: string; requestedAt: string; completedAt: string | null; detail: string }

/** One setting of a component's option, as the editor shows it (a secret setting takes a secret reference). */
export type ConfigurationSettingDto = { name: string; type: string; description: string; required: boolean; secret: boolean; default?: unknown }

/** A component in the list: its descriptor, its newest version and where it can be applied (with what runs there). */
export type ConfigurationComponentSummaryDto = { component: string; componentVersion: string; descriptorDigest: string; head: number | null; targets: (ConfigurationTargetDto & { applied: number | null })[] }

/** A component's page: its options, its versions and its applies. */
export type ConfigurationComponentDto = {
    component: string
    componentVersion: string
    descriptorDigest: string
    options: { name: string; description: string; settings: ConfigurationSettingDto[] }[]
    versions: ConfigurationVersionSummaryDto[]
    applies: ConfigurationApplyDto[]
}

/** A secret written for a component: the reference a configuration uses for it (never the value). */
export type ConfigurationSecretDto = { name: string; reference: string }

/** The console does not configure that component, or the scope has no such version, component version or target. */
export class ConfigurationNotFoundError extends Error
{
    private static readonly ErrorName = 'ConfigurationNotFoundError'
    public static readonly ComponentMessage = 'This console does not configure that component.'
    public static readonly VersionMessage = 'That configuration version does not exist.'
    public static readonly EnvironmentMessage = 'That target does not exist.'
    public static readonly ComponentVersionMessage = 'No platform release this hive adopted ships that component version.'

    public constructor(message: string)
    {
        super(message)
        this.name = ConfigurationNotFoundError.ErrorName
    }
}

/** The component has no deployment this console can configure (by that name). */
export class ConfigurationNoTargetError extends Error
{
    private static readonly ErrorName = 'ConfigurationNoTargetError'
    private static readonly Text = 'This component has no deployment the console can configure there.'

    public constructor()
    {
        super(ConfigurationNoTargetError.Text)
        this.name = ConfigurationNoTargetError.ErrorName
    }
}

/** A secret name that cannot be a key of the component's Secret. */
export class ConfigurationSecretNameError extends Error
{
    private static readonly ErrorName = 'ConfigurationSecretNameError'
    private static readonly Text = 'A secret name is letters, digits, "-", "_" and "." (not first), at most 253 characters.'

    public constructor()
    {
        super(ConfigurationSecretNameError.Text)
        this.name = ConfigurationSecretNameError.ErrorName
    }
}

/**
 * The tenant admin console's configuration repository (stage C, server side): per component of its hive, the versions
 * of its configuration in the console's Postgres (pragmatic-configuration), each validated on save against the descriptor
 * of the component version it will run with (the console's own release by default, or a named component version from
 * the signed platform release that ships it). A version is applied to one target (a deployment found by its labels):
 * refused when the target's running image carries another descriptor than the one the version was validated against;
 * otherwise the `pragmatic-config-<component>` ConfigMap and the content hash on the pod template are written and the roll
 * is watched, recorded as an apply (pending, then applied, or failed with a fixed detail: `rollout-not-ready` when the
 * new pods did not become ready and the previous configuration was restored). The realm is the tenant's (one realm per
 * tenant). Secret settings are secret references only; secret values are written by `PutSecret` into the component's own
 * Secret and never stored, logged or answered.
 */
export class ConfigurationService
{
    public static readonly WriteFailedDetail = 'The cluster refused the write.'
    public static readonly DescriptorChangedDetail = 'The version was validated for another component version; save it again for this one.'
    /** The new pods did not become ready in time; the previous configuration is running again. */
    public static readonly RolloutNotReadyDetail = 'rollout-not-ready'
    /** Applied to a target whose running descriptor could not be read (a development image): only the component's own
     *  start check compared the descriptors. */
    public static readonly UnverifiedTargetDetail = 'unverified-target'
    private static readonly NoDetail = ''
    private static readonly SecretNamePattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,252}$/
    private static readonly KeySeparator = '|'

    // The targets an apply is waiting on (one console process serves a tenant): a second apply there is refused.
    private readonly applying = new Set<string>()

    public constructor(
        private readonly repository: IConfigurationRepository,
        private readonly components: IComponentDescriptorSource,
        private readonly targets: IConfigurationTargetSource,
        private readonly applier: IConfigurationApplier,
        private readonly secrets: IComponentSecretWriter)
    {
    }

    /** Every component the console configures, with its head and its targets (what is applied at each). */
    public async List(tenantId: string): Promise<ConfigurationComponentSummaryDto[]>
    {
        const out: ConfigurationComponentSummaryDto[] = []
        for (const name of this.components.Names())
        {
            const descriptor = this.CurrentOf(name)
            const scope = new ConfigurationScope(tenantId, name)
            const head = await this.repository.Head(scope)
            const targets: ConfigurationComponentSummaryDto['targets'] = []
            for (const t of await this.targets.For(name, tenantId))
            {
                const applied = await this.repository.Applied(scope, t.Target)
                targets.push({ ...ConfigurationService.TargetDto(t), applied: applied === null ? null : applied.Version })
            }
            out.push({ component: name, componentVersion: descriptor.Version, descriptorDigest: descriptor.ContentDigest(), head: head === null ? null : head.Number, targets })
        }
        return out
    }

    /** A component's options, versions (oldest first) and applies (oldest first). */
    public async Component(tenantId: string, component: string): Promise<ConfigurationComponentDto>
    {
        const descriptor = this.CurrentOf(component)
        const scope = new ConfigurationScope(tenantId, component)
        const targets = await this.targets.For(component, tenantId)
        return {
            component,
            componentVersion: descriptor.Version,
            descriptorDigest: descriptor.ContentDigest(),
            options: descriptor.Options.map(o => ({ name: o.Name, description: o.Description, settings: o.Settings.map(s => ConfigurationService.SettingDto(s)) })),
            versions: (await this.repository.Versions(scope)).map(v => ConfigurationService.SummaryOf(v)),
            applies: (await this.repository.Applies(scope)).map(a => ConfigurationService.ApplyDto(a, targets)),
        }
    }

    public async Version(tenantId: string, component: string, version: number): Promise<ConfigurationVersionDto>
    {
        const found = await this.VersionOf(tenantId, component, version)
        return { ...ConfigurationService.SummaryOf(found), document: found.Document }
    }

    /** What changed from version `from` (0: the empty document) to version `to`. */
    public async Diff(tenantId: string, component: string, from: number, to: number): Promise<{ from: number; to: number; changes: ConfigurationChange[] }>
    {
        const before = from === 0 ? {} : (await this.VersionOf(tenantId, component, from)).Document
        const after = (await this.VersionOf(tenantId, component, to)).Document
        return { from, to, changes: ConfigurationDiff.Between(before, after) }
    }

    /**
     * Saves `document` as the next version (based on version `basedOn`), validated against the descriptor of
     * `componentVersion` (default: the version the console's release ships). The repository's errors pass through:
     * ConfigurationRejectedError (invalid, literal secrets), ConfigurationHeadMovedError (another save landed first),
     * ConfigurationRequestError; DescriptorUnavailableError when that version's release cannot be read.
     */
    public async Save(tenantId: string, component: string, basedOn: number, document: unknown, author: string, comment: string, componentVersion?: string): Promise<ConfigurationVersionSummaryDto>
    {
        const descriptor = componentVersion === undefined ? this.CurrentOf(component) : await this.DescriptorFor(component, componentVersion)
        const saved = await this.repository.Save(new ConfigurationSaveRequest(new ConfigurationScope(tenantId, component), basedOn, document, descriptor, author, comment))
        return ConfigurationService.SummaryOf(saved)
    }

    /**
     * Applies version `version` to the component's target named `target` (its environment, or its namespace): recorded
     * pending, written and watched, then completed applied or failed (a fixed detail; the cluster's own text is not kept).
     * Refused before anything is recorded when the version is unknown, the console cannot reach its cluster
     * (ConfigurationApplyUnavailableError), the target is unknown (ConfigurationNotFoundError, ConfigurationNoTargetError), or the target's image
     * runs another descriptor than the version's (ConfigurationDescriptorMismatchError, naming both digests).
     */
    public async Apply(tenantId: string, component: string, version: number, target: string, requestedBy: string): Promise<ConfigurationApplyDto>
    {
        this.CurrentOf(component)
        const saved = await this.VersionOf(tenantId, component, version)
        if (!this.applier.Available)
        {
            throw new ConfigurationApplyUnavailableError()
        }
        const targets = await this.targets.For(component, tenantId)
        if (targets.length === 0)
        {
            throw new ConfigurationNoTargetError()
        }
        const found = targets.find(t => t.Name === target)
        if (found === undefined)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.EnvironmentMessage)
        }
        if (found.DescriptorDigest !== undefined && found.DescriptorDigest !== saved.DescriptorDigest)
        {
            throw new ConfigurationDescriptorMismatchError(saved.DescriptorDigest, found.DescriptorDigest)
        }
        const descriptor = await this.components.For(component, saved.ComponentVersion)
        const scope = new ConfigurationScope(tenantId, component)
        const key = scope.Key() + ConfigurationService.KeySeparator + found.Target.Key()
        if (this.applying.has(key))
        {
            throw new ConfigurationApplyInProgressError()
        }
        this.applying.add(key)
        try
        {
            const pending = await this.repository.BeginApply(new ApplyRequest(scope, saved.Number, found.Target, requestedBy))
            const outcome = await this.Write(saved, descriptor, found)
            const record = await this.repository.CompleteApply(scope, pending.Id, outcome.outcome, outcome.detail)
            return ConfigurationService.ApplyDto(record, targets)
        }
        finally
        {
            this.applying.delete(key)
        }
    }

    /**
     * Writes `value` as the secret `name` of `component` for one target (key `name` of the Secret
     * `pragmatic-secrets-<component>` in that target's namespace, so an environment never sees another's value) and answers
     * the reference a configuration uses for it, `secret:file/<name>`. The value is never kept, logged or answered; a
     * refused write is ConfigurationSecretWriteError.
     */
    public async PutSecret(tenantId: string, component: string, target: string, name: string, value: string): Promise<ConfigurationSecretDto>
    {
        this.CurrentOf(component)
        if (!ConfigurationService.SecretNamePattern.test(name))
        {
            throw new ConfigurationSecretNameError()
        }
        if (!this.applier.Available)
        {
            throw new ConfigurationApplyUnavailableError()
        }
        const targets = await this.targets.For(component, tenantId)
        if (targets.length === 0)
        {
            throw new ConfigurationNoTargetError()
        }
        const found = targets.find(t => t.Name === target)
        if (found === undefined)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.EnvironmentMessage)
        }
        let reference: SecretReference
        try
        {
            reference = await this.secrets.Put(component, name, value, [found.Target])
        }
        catch
        {
            throw new ConfigurationSecretWriteError()
        }
        return { name, reference: reference.Format() }
    }

    private async Write(saved: ConfigurationVersion, descriptor: ComponentDescriptor | undefined, target: ConfigurationTarget): Promise<{ outcome: ApplyOutcome; detail: string }>
    {
        const S = ConfigurationService
        if (descriptor === undefined)
        {
            return { outcome: ApplyOutcome.Failed, detail: S.DescriptorChangedDetail }
        }
        let applied: AppliedConfiguration
        try
        {
            applied = AppliedConfiguration.From(saved, descriptor)
        }
        catch
        {
            return { outcome: ApplyOutcome.Failed, detail: S.DescriptorChangedDetail }
        }
        try
        {
            const result = await this.applier.Apply(applied, target.Target)
            if (result !== ConfigurationApplyResult.Applied)
            {
                return { outcome: ApplyOutcome.Failed, detail: S.RolloutNotReadyDetail }
            }
            return { outcome: ApplyOutcome.Applied, detail: target.DescriptorDigest === undefined ? S.UnverifiedTargetDetail : S.NoDetail }
        }
        catch
        {
            return { outcome: ApplyOutcome.Failed, detail: S.WriteFailedDetail }
        }
    }

    private CurrentOf(component: string): ComponentDescriptor
    {
        const descriptor = this.components.Current(component)
        if (descriptor === undefined)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.ComponentMessage)
        }
        return descriptor
    }

    private async DescriptorFor(component: string, componentVersion: string): Promise<ComponentDescriptor>
    {
        this.CurrentOf(component)
        const descriptor = await this.components.For(component, componentVersion)
        if (descriptor === undefined)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.ComponentVersionMessage)
        }
        return descriptor
    }

    private async VersionOf(tenantId: string, component: string, version: number): Promise<ConfigurationVersion>
    {
        this.CurrentOf(component)
        const found = Number.isSafeInteger(version) && version > 0 ? await this.repository.Version(new ConfigurationScope(tenantId, component), version) : null
        if (found === null)
        {
            throw new ConfigurationNotFoundError(ConfigurationNotFoundError.VersionMessage)
        }
        return found
    }

    private static TargetDto(t: ConfigurationTarget): ConfigurationTargetDto
    {
        return {
            environment: t.Name, hive: t.Target.Hive, namespace: t.Target.Namespace, deployment: t.Target.Deployment,
            componentVersion: t.ComponentVersion ?? null, descriptorDigest: t.DescriptorDigest ?? null,
        }
    }

    private static SummaryOf(v: ConfigurationVersion): ConfigurationVersionSummaryDto
    {
        return { version: v.Number, componentVersion: v.ComponentVersion, descriptorDigest: v.DescriptorDigest, author: v.Author, createdAt: v.CreatedAt.toISOString(), comment: v.Comment }
    }

    private static ApplyDto(a: ApplyRecord, targets: readonly ConfigurationTarget[]): ConfigurationApplyDto
    {
        const environment = targets.find(t => t.Target.Equals(a.Target))?.Name ?? a.Target.Namespace
        return {
            id: a.Id, version: a.Version, environment, outcome: a.Outcome, requestedBy: a.RequestedBy, requestedAt: a.RequestedAt.toISOString(),
            completedAt: a.CompletedAt === undefined ? null : a.CompletedAt.toISOString(), detail: a.Detail,
        }
    }

    private static SettingDto(s: { Name: string; Type: string; Description: string; Required: boolean; Secret: boolean; Default: unknown }): ConfigurationSettingDto
    {
        const dto: ConfigurationSettingDto = { name: s.Name, type: s.Type, description: s.Description, required: s.Required, secret: s.Secret }
        if (s.Default !== undefined)
        {
            dto.default = s.Default
        }
        return dto
    }
}
