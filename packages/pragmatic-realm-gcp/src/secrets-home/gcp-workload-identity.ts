import { IdentityPoolClient } from 'google-auth-library'
import { RealmSecretName, RealmSecretsOption, RealmSecretsSettingRule, SecretsHomeFailure, SecretsHomeUnavailableError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IRealmSecretStore, IRealmSecretsHomeFactory, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

/** The Google endpoints a GCP secrets home talks to; tests point them at recorded fakes. */
export class GcpEndpoints
{
    public static readonly Google = new GcpEndpoints('https://sts.googleapis.com', 'https://iamcredentials.googleapis.com', 'https://secretmanager.googleapis.com')

    public constructor(public readonly Sts: string, public readonly IamCredentials: string, public readonly SecretManager: string)
    {
        Object.freeze(this)
    }
}

/**
 * A realm's secrets in Google Secret Manager, as a workload identity: every request carries an access token the
 * `IdentityPoolClient` obtained by exchanging the component's projected service-account token at Google's STS (and,
 * with a service account to impersonate, at IAM Credentials). The client is built explicitly from the realm option's
 * identifiers; Application Default Credentials, `GOOGLE_APPLICATION_CREDENTIALS` and the metadata server are never
 * consulted. Secret ids are `<realm>_<name>` (neither a realm id nor a name holds `_`), so two realms in one project never
 * collide, operators see the name in the console, and an IAM condition on the `<realm>_` prefix confines a realm's
 * workloads to its own secrets.
 *
 * Absent secrets (and absent pinned versions) read as null. Everything else fails typed, never with Google's text.
 */
export class GcpRealmSecretStore implements IRealmSecretStore
{
    private static readonly RealmSeparator = '_'
    private static readonly ApiVersion = '/v1/projects/'
    private static readonly SecretsSegment = '/secrets'
    private static readonly SecretSegment = '/secrets/'
    private static readonly VersionsSegment = '/versions/'
    private static readonly Latest = 'latest'
    private static readonly AccessSuffix = ':access'
    private static readonly AddVersionSuffix = ':addVersion'
    private static readonly SecretIdQuery = '?secretId='
    private static readonly Get = 'GET'
    private static readonly Post = 'POST'
    private static readonly Delete = 'DELETE'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly AutomaticReplication = { automatic: {} }
    private static readonly Unauthorized = 401
    private static readonly Forbidden = 403
    private static readonly NotFound = 404
    private static readonly Conflict = 409
    private static readonly NetworkCodes: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

    public constructor(
        private readonly auth: IdentityPoolClient,
        private readonly endpoints: GcpEndpoints,
        private readonly projectId: string,
        private readonly context: WorkloadContext,
        private readonly replicaLocation: string | undefined)
    {
    }

    /** The Secret Manager id a realm secret is stored under. */
    public static SecretIdFor(realm: string, name: string): string
    {
        return realm + GcpRealmSecretStore.RealmSeparator + name
    }

    /** At start: the projected token is readable (nothing is sent to Google). */
    public async Verify(): Promise<void>
    {
        await this.context.ReadToken(RealmSecretsOption.Gcp)
    }

    public async Get(key: string): Promise<string | null>
    {
        const G = GcpRealmSecretStore
        const name = RealmSecretName.TryParse(key)
        if (name === undefined) return null
        await this.context.ReadToken(RealmSecretsOption.Gcp)
        const url = this.SecretUrl(name.Name) + G.VersionsSegment + (name.Version ?? G.Latest) + G.AccessSuffix
        const response = await this.Send<{ payload?: { data?: string } }>(G.Get, url, undefined, [G.NotFound])
        if (response === undefined) return null
        const data = response.payload?.data
        return data === undefined ? null : Buffer.from(data, G.Base64).toString(G.Utf8)
    }

    public async Put(key: string, secret: string): Promise<void>
    {
        const G = GcpRealmSecretStore
        const name = RealmSecretName.ForWrite(key)
        await this.context.ReadToken(RealmSecretsOption.Gcp)
        const id = G.SecretIdFor(this.context.RealmId, name.Name)
        const replication = this.replicaLocation === undefined ? G.AutomaticReplication : { userManaged: { replicas: [{ location: this.replicaLocation }] } }
        await this.Send(G.Post, this.endpoints.SecretManager + G.ApiVersion + this.projectId + G.SecretsSegment + G.SecretIdQuery + id, { replication }, [G.Conflict])
        await this.Send(G.Post, this.SecretUrl(name.Name) + G.AddVersionSuffix, { payload: { data: Buffer.from(secret, G.Utf8).toString(G.Base64) } }, [])
    }

    public async Delete(key: string): Promise<void>
    {
        const G = GcpRealmSecretStore
        const name = RealmSecretName.ForWrite(key)
        await this.context.ReadToken(RealmSecretsOption.Gcp)
        await this.Send(G.Delete, this.SecretUrl(name.Name), undefined, [G.NotFound])
    }

    private SecretUrl(name: string): string
    {
        const G = GcpRealmSecretStore
        return this.endpoints.SecretManager + G.ApiVersion + this.projectId + G.SecretSegment + G.SecretIdFor(this.context.RealmId, name)
    }

    // One request; `tolerated` statuses answer undefined. Failures are typed by where they happened.
    private async Send<T>(method: string, url: string, data: unknown, tolerated: readonly number[]): Promise<T | undefined>
    {
        try
        {
            const response = await this.auth.request<T>({ url, method, data, retry: false })
            return response.data
        }
        catch (error)
        {
            if (error instanceof SecretsHomeUnavailableError) throw error
            const status = GcpRealmSecretStore.StatusOf(error)
            const failedUrl = GcpRealmSecretStore.UrlOf(error)
            if (failedUrl === undefined || !failedUrl.startsWith(this.endpoints.SecretManager + GcpRealmSecretStore.ApiVersion + this.projectId + GcpRealmSecretStore.SecretsSegment))
            {
                // The token exchange (STS or IAM Credentials) failed: refused when it answered, else unreachable.
                throw new SecretsHomeUnavailableError(RealmSecretsOption.Gcp, GcpRealmSecretStore.IsNetworkFailure(error) ? SecretsHomeFailure.Unreachable : SecretsHomeFailure.ExchangeRefused)
            }
            if (status !== undefined && tolerated.includes(status)) return undefined
            throw new SecretsHomeUnavailableError(RealmSecretsOption.Gcp, GcpRealmSecretStore.FailureOf(status))
        }
    }

    private static FailureOf(status: number | undefined): SecretsHomeFailure
    {
        const G = GcpRealmSecretStore
        if (status === G.Forbidden) return SecretsHomeFailure.PermissionDenied
        if (status === G.Unauthorized) return SecretsHomeFailure.ExchangeRefused
        if (status === G.NotFound) return SecretsHomeFailure.NotFound
        return SecretsHomeFailure.Unreachable
    }

    private static IsNetworkFailure(error: unknown): boolean
    {
        const own = (error as { code?: unknown } | null)?.code
        const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
        return [own, cause].some(code => typeof code === 'string' && GcpRealmSecretStore.NetworkCodes.has(code))
    }

    private static StatusOf(error: unknown): number | undefined
    {
        const status = (error as { response?: { status?: unknown } } | null)?.response?.status
        return typeof status === 'number' ? status : undefined
    }

    private static UrlOf(error: unknown): string | undefined
    {
        const url = (error as { config?: { url?: unknown } } | null)?.config?.url
        return url === undefined ? undefined : String(url)
    }
}

/**
 * The GCP option's secrets home (`IRealmSecretsHomeFactory`). Settings, identifiers only: `projectId` (the project
 * holding the realm's secrets), `workloadIdentityAudience` (the workload identity pool provider the cluster's issuer is
 * registered with), optional `serviceAccountEmail` (a service account to impersonate; without it the federated
 * principal itself is bound) and optional `replicaLocation` (pin new secrets to one region).
 */
export class GcpWorkloadIdentity implements IRealmSecretsHomeFactory
{
    public static readonly ProjectId = 'projectId'
    public static readonly Audience = 'workloadIdentityAudience'
    public static readonly ServiceAccountEmail = 'serviceAccountEmail'
    public static readonly ReplicaLocation = 'replicaLocation'
    private static readonly SubjectTokenType = 'urn:ietf:params:oauth:token-type:jwt'
    private static readonly ExternalAccount = 'external_account'
    private static readonly TokenPath = '/v1/token'
    private static readonly ImpersonationPrefix = '/v1/projects/-/serviceAccounts/'
    private static readonly ImpersonationSuffix = ':generateAccessToken'
    private static readonly CloudPlatformScope = 'https://www.googleapis.com/auth/cloud-platform'
    private static readonly ProjectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
    private static readonly ProjectForm = 'a Google Cloud project id'
    private static readonly AudiencePattern = /^\/\/iam\.googleapis\.com\/projects\/[0-9]{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/
    private static readonly AudienceForm = 'a workload identity pool provider (//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>)'
    private static readonly EmailPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
    private static readonly EmailForm = 'a service account email (<name>@<project>.iam.gserviceaccount.com)'
    private static readonly RegionPattern = /^[a-z]+-[a-z]+[0-9]{1,2}$/
    private static readonly RegionForm = 'a Google Cloud region'

    public readonly Option = RealmSecretsOption.Gcp
    public readonly Settings: readonly RealmSecretsSettingRule[] = [
        new RealmSecretsSettingRule(GcpWorkloadIdentity.ProjectId, GcpWorkloadIdentity.ProjectPattern, true, GcpWorkloadIdentity.ProjectForm),
        new RealmSecretsSettingRule(GcpWorkloadIdentity.Audience, GcpWorkloadIdentity.AudiencePattern, true, GcpWorkloadIdentity.AudienceForm),
        new RealmSecretsSettingRule(GcpWorkloadIdentity.ServiceAccountEmail, GcpWorkloadIdentity.EmailPattern, false, GcpWorkloadIdentity.EmailForm),
        new RealmSecretsSettingRule(GcpWorkloadIdentity.ReplicaLocation, GcpWorkloadIdentity.RegionPattern, false, GcpWorkloadIdentity.RegionForm),
    ]

    public constructor(private readonly endpoints: GcpEndpoints = GcpEndpoints.Google)
    {
    }

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<IRealmSecretStore>
    {
        const G = GcpWorkloadIdentity
        const email = settings.Get(G.ServiceAccountEmail)
        const auth = new IdentityPoolClient({
            type: G.ExternalAccount,
            audience: settings.Get(G.Audience)!,
            subject_token_type: G.SubjectTokenType,
            token_url: this.endpoints.Sts + G.TokenPath,
            service_account_impersonation_url: email === undefined ? undefined : this.endpoints.IamCredentials + G.ImpersonationPrefix + email + G.ImpersonationSuffix,
            subject_token_supplier: { getSubjectToken: () => context.ReadToken(RealmSecretsOption.Gcp) },
            scopes: [G.CloudPlatformScope],
        })
        return Promise.resolve(new GcpRealmSecretStore(auth, this.endpoints, settings.Get(G.ProjectId)!, context, settings.Get(G.ReplicaLocation)))
    }
}
