/** The names the applied-configuration object and its file use: one home for every key. */
export class AppliedConfigurationKeys
{
    public static readonly SchemaVersion = 1;
    public static readonly ObjectNamePrefix = 'pragmatic-config-';
    /** Kubernetes object names (and the label values derived from them) stay within a DNS label. */
    public static readonly MaxObjectNameLength = 63;
    public static readonly FileName = 'configuration.json';

    public static readonly Schema = 'schema';
    public static readonly Realm = 'realm';
    public static readonly Component = 'component';
    public static readonly Version = 'version';
    public static readonly ComponentVersion = 'componentVersion';
    public static readonly DescriptorDigest = 'descriptorDigest';
    public static readonly Document = 'document';

    public static readonly ApiVersion = 'v1';
    public static readonly Kind = 'ConfigMap';
    public static readonly ComponentLabel = 'app.kubernetes.io/component';
    public static readonly ManagedByLabel = 'app.kubernetes.io/managed-by';
    public static readonly ManagedBy = 'pragmatic-tenant-admin';
    public static readonly VersionAnnotation = 'pragmatic-tech.ai/configuration-version';
    public static readonly DigestAnnotation = 'pragmatic-tech.ai/descriptor-digest';
    public static readonly RealmAnnotation = 'pragmatic-tech.ai/realm';
    /** On the ConfigMap and on the deployment's pod template: a new value rolls the deployment. */
    public static readonly HashAnnotation = 'pragmatic-tech.ai/configuration-hash';
    /** On the deployment's pod template: the resourceVersion of the component's secrets Secret when the configuration was applied, so a rotated secret rolls the deployment. */
    public static readonly SecretsRevisionAnnotation = 'pragmatic-tech.ai/secrets-revision';

    /** A prepared entry's data key: `configuration.json.sha256-<hex>` (never ending in `.json`, so no reader that scans
     *  the folder for `*.json` files takes it for a configuration of its own). */
    public static readonly PreparedEntryInfix = '.sha256-';
    public static readonly DigestAlgorithmPrefix = 'sha256:';
    /** On the ConfigMap: the descriptor digests a prepared entry exists for, comma separated (the console writes it). */
    public static readonly PreparedDigestsAnnotation = 'pragmatic-tech.ai/prepared-digests';
    /** On the ConfigMap: the descriptors the applied document does not validate against, a JSON array of
     *  `{ descriptorDigest, componentVersion, settings, reason }` (the console writes it). */
    public static readonly PreparationRefusedAnnotation = 'pragmatic-tech.ai/preparation-refused';
}
