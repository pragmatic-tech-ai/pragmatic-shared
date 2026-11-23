import { AppliedConfigurationKeys, ComponentStartConfiguration, ConfigurationRuntimeReader } from '@pragmatic-tech-ai/pragmatic-configuration'

type K8sObject = Record<string, unknown>

/**
 * What every hive workload the console's manifests render carries so the tenant admin console can configure it (C3.1):
 *
 * - labels: `app.kubernetes.io/component=<primary component>` and `app.kubernetes.io/managed-by=pragmatic-tenant-admin`,
 *   plus `component.pragmatic-tech.ai/<component>=true` for every component the pod runs (an init container such as the
 *   UI unpacker included), which is what the console selects a component's targets by. Labels go on the Deployment and
 *   its pod template, never on the selector (a selector is immutable on a live Deployment);
 * - per component, read-only in its own container: the ConfigMap `pragmatic-config-<component>` (optional: absent means no
 *   configuration) at `/etc/pragmatic/configuration`, the Secret `pragmatic-secrets-<component>` (optional; the secret
 *   store `file`) at `/run/secrets/pragmatic/<component>`, and a memory-backed `emptyDir` at `/run/pragmatic/secrets` where
 *   the start step writes resolved secrets (per container, so no component reads another's);
 * - the roll: `RollingUpdate` with `maxUnavailable: 0, maxSurge: 1`, so the old pod serves until the new one is ready.
 */
export class ComponentConfigurationMounts
{
    public static readonly ComponentLabel = AppliedConfigurationKeys.ComponentLabel
    public static readonly ManagedByLabel = AppliedConfigurationKeys.ManagedByLabel
    public static readonly ManagedBy = AppliedConfigurationKeys.ManagedBy
    /** `component.pragmatic-tech.ai/<component>`: one per component a pod runs. */
    public static readonly ConfiguresLabelPrefix = 'component.pragmatic-tech.ai/'
    public static readonly ConfiguresValue = 'true'
    public static readonly SecretNamePrefix = 'pragmatic-secrets-'
    public static readonly ConfigurationMount = ConfigurationRuntimeReader.DefaultDirectory
    public static readonly RuntimeSecretsMount = ComponentStartConfiguration.DefaultSecretsDir
    public static readonly SecretStoreRoot = ComponentStartConfiguration.MountedSecretsRoot

    private static readonly ConfigVolumePrefix = 'cfg-'
    private static readonly StoreVolumePrefix = 'cfgstore-'
    private static readonly RuntimeVolumePrefix = 'cfgrun-'
    private static readonly PragmaticPrefix = 'pragmatic-'
    private static readonly PathSeparator = '/'
    private static readonly MemoryMedium = 'Memory'
    private static readonly RollingUpdate = 'RollingUpdate'
    /** Read-only for the owner and group: the pod's fsGroup reads the mounted secrets. */
    private static readonly SecretFileMode = 0o440
    private static readonly RuntimeSecretsSizeLimit = '1Mi'

    private static readonly NameKey = 'name'
    private static readonly ConfigMapKey = 'configMap'
    private static readonly SecretKey = 'secret'
    private static readonly SecretNameKey = 'secretName'
    private static readonly OptionalKey = 'optional'
    private static readonly DefaultModeKey = 'defaultMode'
    private static readonly EmptyDirKey = 'emptyDir'
    private static readonly MediumKey = 'medium'
    private static readonly SizeLimitKey = 'sizeLimit'
    private static readonly MountPathKey = 'mountPath'
    private static readonly ReadOnlyKey = 'readOnly'
    private static readonly TypeKey = 'type'
    private static readonly RollingUpdateKey = 'rollingUpdate'
    private static readonly MaxUnavailableKey = 'maxUnavailable'
    private static readonly MaxSurgeKey = 'maxSurge'
    private static readonly MetadataKey = 'metadata'
    private static readonly LabelsKey = 'labels'
    private static readonly SpecKey = 'spec'
    private static readonly TemplateKey = 'template'
    private static readonly StrategyKey = 'strategy'
    private static readonly ContainersKey = 'containers'
    private static readonly InitContainersKey = 'initContainers'
    private static readonly VolumesKey = 'volumes'
    private static readonly VolumeMountsKey = 'volumeMounts'
    private static readonly NoContainer = 'ComponentConfigurationMounts: the pod runs no container named'

    private constructor()
    {
    }

    /** `component.pragmatic-tech.ai/<component>`. */
    public static ConfiguresLabel(component: string): string
    {
        return ComponentConfigurationMounts.ConfiguresLabelPrefix + component
    }

    /** The label selector of `component`'s targets. */
    public static SelectorOf(component: string): string
    {
        const M = ComponentConfigurationMounts
        return `${M.ConfiguresLabel(component)}=${M.ConfiguresValue},${M.ManagedByLabel}=${M.ManagedBy}`
    }

    /** `pragmatic-secrets-<component>`: the Secret the console writes a component's secret values into (store `file`). */
    public static SecretNameOf(component: string): string
    {
        return ComponentConfigurationMounts.SecretNamePrefix + component
    }

    /** `pragmatic-config-<component>`. */
    public static ConfigMapNameOf(component: string): string
    {
        return AppliedConfigurationKeys.ObjectNamePrefix + component
    }

    /** The labels of a workload whose main container is `primary` and whose pod also runs `others`. */
    public static Labels(primary: string, others: readonly string[] = []): Record<string, string>
    {
        const M = ComponentConfigurationMounts
        const labels: Record<string, string> = { [M.ComponentLabel]: primary, [M.ManagedByLabel]: M.ManagedBy }
        for (const component of [primary, ...others])
        {
            labels[M.ConfiguresLabel(component)] = M.ConfiguresValue
        }
        return labels
    }

    /** The pod volumes of `component`'s configuration. */
    public static Volumes(component: string): K8sObject[]
    {
        const M = ComponentConfigurationMounts
        const short = M.Short(component)
        return [
            { [M.NameKey]: M.ConfigVolumePrefix + short, [M.ConfigMapKey]: { [M.NameKey]: M.ConfigMapNameOf(component), [M.OptionalKey]: true } },
            { [M.NameKey]: M.StoreVolumePrefix + short, [M.SecretKey]: { [M.SecretNameKey]: M.SecretNameOf(component), [M.OptionalKey]: true, [M.DefaultModeKey]: M.SecretFileMode } },
            { [M.NameKey]: M.RuntimeVolumePrefix + short, [M.EmptyDirKey]: { [M.MediumKey]: M.MemoryMedium, [M.SizeLimitKey]: M.RuntimeSecretsSizeLimit } },
        ]
    }

    /** The mounts of `component`'s configuration, for the container that runs it. */
    public static Mounts(component: string): K8sObject[]
    {
        const M = ComponentConfigurationMounts
        const short = M.Short(component)
        return [
            { [M.NameKey]: M.ConfigVolumePrefix + short, [M.MountPathKey]: M.ConfigurationMount, [M.ReadOnlyKey]: true },
            { [M.NameKey]: M.StoreVolumePrefix + short, [M.MountPathKey]: M.SecretStoreRoot + M.PathSeparator + component, [M.ReadOnlyKey]: true },
            { [M.NameKey]: M.RuntimeVolumePrefix + short, [M.MountPathKey]: M.RuntimeSecretsMount },
        ]
    }

    /** The Deployment strategy: the old pod serves until the new one is ready. */
    public static Strategy(): K8sObject
    {
        const M = ComponentConfigurationMounts
        return { [M.TypeKey]: M.RollingUpdate, [M.RollingUpdateKey]: { [M.MaxUnavailableKey]: 0, [M.MaxSurgeKey]: 1 } }
    }

    /**
     * Makes a rendered Deployment configurable: labels on it and its pod template, the strategy, and for each
     * `{ Container, Component }` (the first is the workload's primary component) that component's volumes and that
     * container's mounts. The container is looked up among the pod's containers and init containers.
     */
    public static Attach(deployment: K8sObject, components: ReadonlyArray<{ Container: string; Component: string }>): K8sObject
    {
        const M = ComponentConfigurationMounts
        const [primary, ...others] = components.map(entry => entry.Component)
        const labels = M.Labels(primary, others)
        const metadata = deployment[M.MetadataKey] as K8sObject
        metadata[M.LabelsKey] = { ...(metadata[M.LabelsKey] as Record<string, string> | undefined), ...labels }
        const spec = deployment[M.SpecKey] as K8sObject
        spec[M.StrategyKey] = M.Strategy()
        const template = spec[M.TemplateKey] as K8sObject
        const templateMetadata = template[M.MetadataKey] as K8sObject
        templateMetadata[M.LabelsKey] = { ...(templateMetadata[M.LabelsKey] as Record<string, string> | undefined), ...labels }
        const pod = template[M.SpecKey] as K8sObject
        const containers = [...(pod[M.ContainersKey] as K8sObject[] | undefined ?? []), ...(pod[M.InitContainersKey] as K8sObject[] | undefined ?? [])]
        const volumes = pod[M.VolumesKey] as K8sObject[] | undefined ?? []
        for (const entry of components)
        {
            const container = containers.find(candidate => candidate[M.NameKey] === entry.Container)
            if (container === undefined) throw new Error(`${M.NoContainer} ${entry.Container}`)
            container[M.VolumeMountsKey] = [...(container[M.VolumeMountsKey] as K8sObject[] | undefined ?? []), ...M.Mounts(entry.Component)]
            volumes.push(...M.Volumes(entry.Component))
        }
        pod[M.VolumesKey] = volumes
        return deployment
    }

    // Volume names are DNS labels (63 characters at most); the shared `pragmatic-` prefix is dropped to keep them short.
    private static Short(component: string): string
    {
        const M = ComponentConfigurationMounts
        return component.startsWith(M.PragmaticPrefix) ? component.slice(M.PragmaticPrefix.length) : component
    }
}
