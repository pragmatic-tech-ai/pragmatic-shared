import { CustomRealmSecrets, RealmSecretsIdentifiers, RealmSecretsOption, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { posix } from 'node:path'
import { ComponentConfigurationMounts } from './component-configuration-mounts.js'
import { HiveLabels } from './hive-labels.js'

type K8sObject = Record<string, unknown>

/** The custom home's material an environment's server reads with: the reader role's database URL and the realm master key. */
export type EnvironmentRealmSecretsMaterial = {
    readonly DatabaseUrl: Buffer
    readonly MasterKey: Buffer
}

/** Reads the custom home's reader material (the console: its mounted files). Declared here, free of any console type. */
export interface IEnvironmentRealmSecretsMaterial
{
    Read(): Promise<EnvironmentRealmSecretsMaterial>
}

/** The engine names a realm secrets option but not what its environments need. */
export class EnvironmentRealmSecretsError extends Error
{
    private static readonly ErrorName = 'EnvironmentRealmSecretsError'

    public constructor(message: string)
    {
        super(message)
        this.name = EnvironmentRealmSecretsError.ErrorName
    }
}

/**
 * How a chart-installed engine's environments reach the realm's secrets home (2.5): the same option and identifiers the
 * chart gives the console, the same realm id, and the environment server's own identity. A cloud option projects the pod's
 * service-account token with the cloud's audience (`expirationSeconds` 3600, rotated by the kubelet) at the token path; the
 * custom option mounts two Secrets in the environment namespace, the reader role's database URL and the realm master key,
 * which the console copies there once (`EnsureCopies`; never replaced: the key and the reader password are minted once).
 * No cloud credential exists anywhere: the settings are identifiers only, and only the option's own identifier names are
 * carried over (anything else the console's environment holds is refused). The server runs as its own service account
 * `pragmatic-env-server` (no API token mounted), so a cloud binds exactly the environments' servers, by that name, and no
 * other pod of an environment namespace.
 */
export class EnvironmentRealmSecrets
{
    public static readonly Component = ReleaseApp.EnvServer
    public static readonly TokenFile = WorkloadContext.DefaultTokenPath
    public static readonly TokenDirectory = posix.dirname(WorkloadContext.DefaultTokenPath)
    public static readonly TokenFileName = posix.basename(WorkloadContext.DefaultTokenPath)
    /** The environment server's own account in its namespace: the subject every cloud binds (`system:serviceaccount:pragmatic-env-<env>:pragmatic-env-server`). */
    public static readonly ServiceAccountName = 'pragmatic-env-server'
    public static readonly TokenExpirationSeconds = 3600
    public static readonly AzureAudience = 'api://AzureADTokenExchange'
    public static readonly AwsAudience = 'sts.amazonaws.com'
    /** The GCP setting naming the pool provider, which is the token's audience. */
    public static readonly GcpAudienceSetting = 'workloadIdentityAudience'
    /** The environment namespace's copies (custom option): the reader role's URL and the realm master key. */
    public static readonly ReaderSecretName = 'pragmatic-realm-secrets-reader'
    public static readonly MasterKeySecretName = 'pragmatic-realm-master-key'
    public static readonly DatabaseUrlKey = 'database-url'
    public static readonly MasterKeyKey = 'master.key'
    public static readonly ReaderMount = '/run/secrets/pragmatic-realm-secrets'
    public static readonly MasterKeyMount = '/run/secrets/pragmatic-realm-master-key'
    public static readonly TokenVolume = 'realm-workload-identity'
    public static readonly ReaderVolume = 'realm-secrets-reader'
    public static readonly MasterKeyVolume = 'realm-master-key'
    private static readonly SecretFileMode = 0o440
    private static readonly PathSeparator = '/'
    private static readonly NameKey = 'name'
    private static readonly ValueKey = 'value'
    private static readonly MountPathKey = 'mountPath'
    private static readonly ReadOnlyKey = 'readOnly'
    private static readonly SecretKey = 'secret'
    private static readonly SecretNameKey = 'secretName'
    private static readonly DefaultModeKey = 'defaultMode'
    private static readonly ItemsKey = 'items'
    private static readonly KeyKey = 'key'
    private static readonly PathKey = 'path'
    private static readonly ProjectedKey = 'projected'
    private static readonly SourcesKey = 'sources'
    private static readonly ServiceAccountTokenKey = 'serviceAccountToken'
    private static readonly AudienceKey = 'audience'
    private static readonly ExpirationKey = 'expirationSeconds'
    private static readonly SecretResourcePrefix = 'secret/'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NamespaceKey = 'namespace'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'
    private static readonly ApiVersion = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly NoMaterial = 'the custom realm secrets option needs the reader material the environments read with (PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_READER_URL_FILE and the realm master key)'
    private static readonly NoAudience = 'the gcp realm secrets option needs PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE (the pool provider) for the environments\' projected token'
    private static readonly NoRealm = 'a realm secrets option needs PRAGMATIC_REALM_ID'
    private static readonly UnknownSetting = ' is not an identifier of the realm secrets option '
    private static readonly ServiceAccountKind = 'ServiceAccount'
    private static readonly LabelsKey = 'labels'
    private static readonly AutomountKey = 'automountServiceAccountToken'

    private constructor(
        public readonly Option: RealmSecretsOption,
        public readonly RealmId: string,
        /** The cloud option's identifiers by setting name (none for custom: its file paths are the environment's own). */
        private readonly settings: ReadonlyMap<string, string>,
        private readonly material: IEnvironmentRealmSecretsMaterial | undefined)
    {
        Object.freeze(this)
    }

    /**
     * From the console's own environment (the chart renders the same option and identifiers into it), or undefined when it
     * names no realm secrets option. The custom option needs `material`; the console's own file paths and access are not
     * carried over (an environment reads with the reader role, from its own mounts).
     */
    public static FromEnvironment(env: Readonly<Record<string, string | undefined>>, material?: IEnvironmentRealmSecretsMaterial): EnvironmentRealmSecrets | undefined
    {
        const E = EnvironmentRealmSecrets
        const settings = RealmSecretsSettings.FromEnvironment(env)
        if (settings === undefined) return undefined
        const realm = env[WorkloadContext.RealmVariable]
        if (realm === undefined || realm === '' || !WorkloadContext.RealmPattern.test(realm)) throw new EnvironmentRealmSecretsError(E.NoRealm)
        if (settings.Option === RealmSecretsOption.Custom)
        {
            if (material === undefined) throw new EnvironmentRealmSecretsError(E.NoMaterial)
            return new EnvironmentRealmSecrets(settings.Option, realm, new Map(), material)
        }
        const allowed = RealmSecretsIdentifiers.Of(settings.Option)
        for (const name of settings.Names)
        {
            if (!allowed.includes(name)) throw new EnvironmentRealmSecretsError(RealmSecretsSettings.VariableOf(name) + E.UnknownSetting + settings.Option)
        }
        const values = new Map(settings.Names.map(name => [name, settings.Get(name)!]))
        if (settings.Option === RealmSecretsOption.Gcp && !values.has(E.GcpAudienceSetting)) throw new EnvironmentRealmSecretsError(E.NoAudience)
        return new EnvironmentRealmSecrets(settings.Option, realm, values, undefined)
    }

    public get Cloud(): boolean
    {
        return this.Option !== RealmSecretsOption.Custom
    }

    /** The projected token's audience: the pool provider on GCP, Entra's token exchange on Azure, STS on AWS; none for custom. */
    public get Audience(): string | undefined
    {
        const E = EnvironmentRealmSecrets
        switch (this.Option)
        {
            case RealmSecretsOption.Gcp:
                return this.settings.get(E.GcpAudienceSetting)
            case RealmSecretsOption.Azure:
                return E.AzureAudience
            case RealmSecretsOption.Aws:
                return E.AwsAudience
            default:
                return undefined
        }
    }

    /** The env server container's variables: the option, its settings, the realm, the component and (cloud) the token file. */
    public EnvVars(): K8sObject[]
    {
        const E = EnvironmentRealmSecrets
        const C = CustomRealmSecrets
        const vars: Array<[string, string]> = [[RealmSecretsSettings.OptionVariable, this.Option]]
        if (this.Cloud)
        {
            for (const [name, value] of [...this.settings].sort(([a], [b]) => a.localeCompare(b)))
            {
                vars.push([RealmSecretsSettings.VariableOf(name), value])
            }
        }
        else
        {
            vars.push(
                [RealmSecretsSettings.VariableOf(C.DatabaseUrlFile), E.ReaderMount + E.PathSeparator + E.DatabaseUrlKey],
                [RealmSecretsSettings.VariableOf(C.MasterKeyFile), E.MasterKeyMount + E.PathSeparator + E.MasterKeyKey],
                [RealmSecretsSettings.VariableOf(C.Access), C.ReaderAccess],
            )
        }
        vars.push([WorkloadContext.RealmVariable, this.RealmId], [WorkloadContext.ComponentVariable, E.Component])
        if (this.Cloud) vars.push([WorkloadContext.TokenVariable, E.TokenFile])
        return vars.map(([name, value]) => ({ [E.NameKey]: name, [E.ValueKey]: value }))
    }

    public VolumeMounts(): K8sObject[]
    {
        const E = EnvironmentRealmSecrets
        const mount = (name: string, path: string): K8sObject => ({ [E.NameKey]: name, [E.MountPathKey]: path, [E.ReadOnlyKey]: true })
        return this.Cloud ? [mount(E.TokenVolume, E.TokenDirectory)] : [mount(E.ReaderVolume, E.ReaderMount), mount(E.MasterKeyVolume, E.MasterKeyMount)]
    }

    public Volumes(): K8sObject[]
    {
        const E = EnvironmentRealmSecrets
        if (this.Cloud)
        {
            return [{
                [E.NameKey]: E.TokenVolume,
                [E.ProjectedKey]: {
                    [E.DefaultModeKey]: E.SecretFileMode,
                    [E.SourcesKey]: [{ [E.ServiceAccountTokenKey]: { [E.AudienceKey]: this.Audience, [E.ExpirationKey]: E.TokenExpirationSeconds, [E.PathKey]: E.TokenFileName } }],
                },
            }]
        }
        const secret = (volume: string, name: string, key: string): K8sObject => ({
            [E.NameKey]: volume,
            [E.SecretKey]: { [E.SecretNameKey]: name, [E.DefaultModeKey]: E.SecretFileMode, [E.ItemsKey]: [{ [E.KeyKey]: key, [E.PathKey]: key }] },
        })
        return [secret(E.ReaderVolume, E.ReaderSecretName, E.DatabaseUrlKey), secret(E.MasterKeyVolume, E.MasterKeySecretName, E.MasterKeyKey)]
    }

    /** The environment server's own account (no API token mounted): the identity every cloud binds. */
    public ServiceAccount(namespace: string, hiveId: string): K8sObject
    {
        const E = EnvironmentRealmSecrets
        return {
            [E.ApiVersionKey]: E.ApiVersion,
            [E.KindKey]: E.ServiceAccountKind,
            [E.MetadataKey]: { [E.NameKey]: E.ServiceAccountName, [E.NamespaceKey]: namespace, [E.LabelsKey]: E.LabelsOf(hiveId) },
            [E.AutomountKey]: false,
        }
    }

    /**
     * The custom option's two Secrets in `namespace` (labelled with the hive and the console as their manager), created
     * when absent and otherwise kept (the reader password and the master key are minted once; a replaced key is refused by
     * every component's start anyway), through kubectl's create only, so no last-applied annotation carries a value. Run at
     * each bring-up of the environment: under a cloud option it removes copies an earlier custom home left, so after a switch
     * of option an environment keeps its copies (and its old pod spec) until it is next brought up.
     */
    public async EnsureCopies(kubectl: IKubectl, namespace: string, hiveId: string): Promise<void>
    {
        const E = EnvironmentRealmSecrets
        const names = [[E.ReaderSecretName, E.DatabaseUrlKey], [E.MasterKeySecretName, E.MasterKeyKey]] as const
        if (this.material === undefined)
        {
            const left: K8sObject[] = []
            for (const [name] of names)
            {
                if (await kubectl.Find(namespace, E.SecretResourcePrefix + name) !== undefined) left.push(E.SecretOf(namespace, hiveId, name, {}))
            }
            for (const item of left) await kubectl.DeleteManifest(JSON.stringify(item))
            return
        }
        const missing: Array<readonly [string, string]> = []
        for (const [name, key] of names)
        {
            if (await kubectl.Find(namespace, E.SecretResourcePrefix + name) === undefined) missing.push([name, key])
        }
        if (missing.length === 0) return
        const material = await this.material.Read()
        for (const [name, key] of missing)
        {
            const value = name === E.ReaderSecretName ? material.DatabaseUrl : material.MasterKey
            await kubectl.Create(JSON.stringify(E.SecretOf(namespace, hiveId, name, { [key]: value.toString(E.Base64) })))
        }
    }

    private static SecretOf(namespace: string, hiveId: string, name: string, data: Record<string, string>): K8sObject
    {
        const E = EnvironmentRealmSecrets
        return {
            [E.ApiVersionKey]: E.ApiVersion,
            [E.KindKey]: E.SecretKind,
            [E.MetadataKey]: { [E.NameKey]: name, [E.NamespaceKey]: namespace, [E.LabelsKey]: E.LabelsOf(hiveId) },
            [E.TypeKey]: E.OpaqueType,
            [E.DataKey]: data,
        }
    }

    private static LabelsOf(hiveId: string): Record<string, string>
    {
        return { ...HiveLabels.Of(hiveId), [ComponentConfigurationMounts.ManagedByLabel]: ComponentConfigurationMounts.ManagedBy }
    }
}
