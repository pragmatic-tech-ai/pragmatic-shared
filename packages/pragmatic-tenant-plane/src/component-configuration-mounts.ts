import { AppliedConfigurationKeys, ComponentStartConfiguration, ConfigurationRuntimeReader } from '@pragmatic-tech-ai/pragmatic-configuration'

type K8sObject = Record<string, unknown>

/** How a workload rolls when its configuration (or image) changes. */
export enum WorkloadRoll
{
    /** Stateless: the old pod serves until a new one is ready. */
    Surge = 'surge',
    /** A single-writer volume: the old pod stops before the new one starts. */
    Recreate = 'recreate',
}

/**
 * What every hive workload the console's manifests render carries so the tenant admin console can configure it (C3.1):
 *
 * - labels: `app.kubernetes.io/component=<primary component>` and `app.kubernetes.io/managed-by=pragmatic-tenant-admin`,
 *   plus `component.pragmatic-tech.ai/<component>=<container>` for every component the pod runs (an init container such
 *   as the UI unpacker included), which is what the console selects a component's targets by and how it finds the
 *   container (and so the image) that runs it. Labels go on the Deployment and its pod template, never on the selector
 *   (a selector is immutable on a live Deployment);
 * - per component, read-only in its own container: the ConfigMap `pragmatic-config-<component>` (optional: absent means no
 *   configuration) at `/etc/pragmatic/configuration`, the Secret `pragmatic-secrets-<component>` (optional; the secret
 *   store `file`) at `/run/secrets/pragmatic/<component>`, and a memory-backed `emptyDir` at `/run/pragmatic/secrets` where
 *   the start step writes resolved secrets (per container, so no component reads another's);
 * - the roll: `RollingUpdate` with `maxUnavailable: 0, maxSurge: 1` for a stateless workload, so the old pod serves
 *   until the new one is ready, and `minReadySeconds` (SurgeMinReadySeconds), so a pod ready for a moment before it
 *   exits is not counted available (the old one would be scaled away and the watch would read ready); `Recreate` for one
 *   with a single-writer volume (an embedded Postgres, a data volume), because a surge pod would start a second writer on
 *   the same ReadWriteOnce data while the old one runs.
 *
 * Attaching is idempotent: a volume, mount or label already there is not added twice (the platform's installer attaches
 * the configuration to a running Deployment it holds on its own pod template).
 */
export class ComponentConfigurationMounts
{
    public static readonly ComponentLabel = AppliedConfigurationKeys.ComponentLabel
    public static readonly ManagedByLabel = AppliedConfigurationKeys.ManagedByLabel
    public static readonly ManagedBy = AppliedConfigurationKeys.ManagedBy
    /** `component.pragmatic-tech.ai/<component>` = the container that runs it: one per component a pod runs. */
    public static readonly ConfiguresLabelPrefix = 'component.pragmatic-tech.ai/'
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
    private static readonly RecreateType = 'Recreate'
    /** Kubernetes label grammar: a name part (63 at most) and a value. */
    private static readonly LabelName = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
    private static readonly BadComponent = 'ComponentConfigurationMounts: a component name must be a Kubernetes label name:'
    private static readonly BadContainer = 'ComponentConfigurationMounts: a container name must be a Kubernetes label value:'
    /** Read-only for the owner and group: the pod's fsGroup reads the mounted secrets. */
    private static readonly SecretFileMode = 0o440
    /** Above the largest Secret (1 MiB of values) the console can write, with room for the file system. */
    private static readonly RuntimeSecretsSizeLimit = '4Mi'
    /** How long a surge-rolled pod stays ready before it counts as available. */
    public static readonly SurgeMinReadySeconds = 10
    private static readonly MinReadySecondsKey = 'minReadySeconds'

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
    private static readonly NoComponents = 'ComponentConfigurationMounts: a workload runs at least one component'
    /** Where the console reads the descriptors of the release it runs (ReleaseDescriptorCatalogue). */
    public static readonly ReleaseDescriptorsMount = '/etc/pragmatic/descriptors'
    /** The optional ConfigMap holding them (`digests.json` and one `<app>.json` each), written by whoever delivers the release. */
    public static readonly ReleaseDescriptorsConfigMap = 'pragmatic-release-descriptors'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly NamespaceKey = 'namespace'
    private static readonly CoreApiVersion = 'v1'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'

    private constructor()
    {
    }

    /** `component.pragmatic-tech.ai/<component>`. */
    public static ConfiguresLabel(component: string): string
    {
        const M = ComponentConfigurationMounts
        if (!M.LabelName.test(component)) throw new Error(`${M.BadComponent} ${component}`)
        return M.ConfiguresLabelPrefix + component
    }

    /** The label selector of `component`'s targets. */
    public static SelectorOf(component: string): string
    {
        const M = ComponentConfigurationMounts
        return `${M.ConfiguresLabel(component)},${M.ManagedByLabel}=${M.ManagedBy}`
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

    /** The labels of a workload running `components` (container and component; the first is the primary one). */
    public static Labels(components: ReadonlyArray<{ Container: string; Component: string }>): Record<string, string>
    {
        const M = ComponentConfigurationMounts
        if (components.length === 0) throw new Error(M.NoComponents)
        const labels: Record<string, string> = { [M.ComponentLabel]: components[0].Component, [M.ManagedByLabel]: M.ManagedBy }
        for (const entry of components)
        {
            if (!M.LabelName.test(entry.Container)) throw new Error(`${M.BadContainer} ${entry.Container}`)
            labels[M.ConfiguresLabel(entry.Component)] = entry.Container
        }
        return labels
    }

    /** The container that runs `component` in a Deployment with these labels; undefined when it does not run it. */
    public static ContainerOf(labels: Readonly<Record<string, unknown>> | undefined, component: string): string | undefined
    {
        const container = labels?.[ComponentConfigurationMounts.ConfiguresLabel(component)]
        return typeof container === 'string' ? container : undefined
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

    /**
     * The empty `pragmatic-config-<component>` ConfigMap and `pragmatic-secrets-<component>` Secret (type Opaque, which is
     * immutable) a hive manifest renders next to a component the console may not create objects beside (pragmatic-system,
     * the IdP namespace): the console then writes them by name only and never holds `create` there, so it can never mint
     * a service-account token Secret. Neither carries `data`, so a re-applied manifest never clears what the console wrote;
     * an empty ConfigMap reads as no configuration.
     */
    public static EmptyObjects(component: string, namespace: string, labels: Record<string, string>): K8sObject[]
    {
        const M = ComponentConfigurationMounts
        const metadata = (name: string): K8sObject => ({ [M.NameKey]: name, [M.NamespaceKey]: namespace, [M.LabelsKey]: { ...labels } })
        return [
            { [M.ApiVersionKey]: M.CoreApiVersion, [M.KindKey]: M.ConfigMapKind, [M.MetadataKey]: metadata(M.ConfigMapNameOf(component)) },
            { [M.ApiVersionKey]: M.CoreApiVersion, [M.KindKey]: M.SecretKind, [M.MetadataKey]: metadata(M.SecretNameOf(component)), [M.TypeKey]: M.OpaqueType },
        ]
    }

    /** The Deployment strategy of a workload that rolls `roll`. */
    public static Strategy(roll: WorkloadRoll): K8sObject
    {
        const M = ComponentConfigurationMounts
        return roll === WorkloadRoll.Recreate
            ? { [M.TypeKey]: M.RecreateType }
            : { [M.TypeKey]: M.RollingUpdate, [M.RollingUpdateKey]: { [M.MaxUnavailableKey]: 0, [M.MaxSurgeKey]: 1 } }
    }

    /**
     * Makes a rendered Deployment configurable: labels on it and its pod template, the strategy of its `roll`, and for each
     * `{ Container, Component }` (the first is the workload's primary component) that component's volumes and that
     * container's mounts. The container is looked up among the pod's containers and init containers.
     */
    public static Attach(deployment: K8sObject, components: ReadonlyArray<{ Container: string; Component: string }>, roll: WorkloadRoll): K8sObject
    {
        const M = ComponentConfigurationMounts
        const labels = M.Labels(components)
        const metadata = deployment[M.MetadataKey] as K8sObject
        metadata[M.LabelsKey] = { ...(metadata[M.LabelsKey] as Record<string, string> | undefined), ...labels }
        const spec = deployment[M.SpecKey] as K8sObject
        spec[M.StrategyKey] = M.Strategy(roll)
        if (roll === WorkloadRoll.Surge) spec[M.MinReadySecondsKey] = M.SurgeMinReadySeconds
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
            const mounts = container[M.VolumeMountsKey] as K8sObject[] | undefined ?? []
            container[M.VolumeMountsKey] = [...mounts, ...M.Mounts(entry.Component).filter(m => !mounts.some(existing => existing[M.NameKey] === m[M.NameKey]))]
            volumes.push(...M.Volumes(entry.Component).filter(v => !volumes.some(existing => existing[M.NameKey] === v[M.NameKey])))
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
