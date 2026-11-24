import { ClientAssertionCredential } from '@azure/identity'
import { SecretClient } from '@azure/keyvault-secrets'
import type { HttpClient } from '@azure/core-rest-pipeline'
import { RealmSecretName, RealmSecretsOption, RealmSecretsSettingRule, RealmSecretsSettingsError, SecretsHomeFailure, SecretsHomeUnavailableError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IRealmSecretStore, IRealmSecretsHomeFactory, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

/**
 * A realm's secrets in an Azure Key Vault (one vault per realm), as an Entra workload identity: a
 * `ClientAssertionCredential` whose assertion is the component's projected service-account token, read on every token
 * request, for the realm option's tenant and client id, at the explicit authority host. This is what
 * `WorkloadIdentityCredential` does, without its fallbacks to `AZURE_*` variables (a token file, a tenant, a token proxy),
 * so nothing ambient can change who the pod is. Secret names are `<realm>--<name>` (a realm id holding `--` is refused,
 * so the form stays injective); each realm has its own vault, which is the access boundary.
 *
 * Absent secrets (and absent pinned versions) read as null. A deletion is purged where the vault lets this identity
 * purge; otherwise the secret stays soft-deleted for the vault's retention, and a later write of that name recovers it
 * first (its old versions come back as history). Everything else fails typed, never with Azure's text.
 */
export class AzureRealmSecretStore implements IRealmSecretStore
{
    private static readonly RealmSeparator = '--'
    private static readonly SeparatorInRealm = 'a realm whose id holds "--" cannot keep its secrets in Key Vault (names are <realm>--<name>)'
    private static readonly Unauthorized = 401
    private static readonly Forbidden = 403
    private static readonly NotFound = 404
    private static readonly Conflict = 409
    private static readonly ServerError = 500
    private static readonly MaxCauseDepth = 8
    private static readonly NetworkCodes: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'REQUEST_SEND_ERROR'])
    private static readonly NetworkErrorCodes: ReadonlySet<string> = new Set(['network_error', 'endpoints_resolution_error', 'post_request_failed', 'get_request_failed'])
    private static readonly CredentialErrors: ReadonlySet<string> = new Set(['AuthenticationError', 'CredentialUnavailableError', 'AggregateAuthenticationError', 'AuthenticationRequiredError'])
    private static readonly PollOptions = { intervalInMs: 500 }
    /** Key Vault's longest secret name. */
    public static readonly MaxNameLength = 127
    /** A realm secret's longest name (RealmSecretName). */
    private static readonly MaxRealmSecretName = 63

    public constructor(private readonly client: SecretClient, private readonly context: WorkloadContext)
    {
    }

    /** The Key Vault secret name a realm secret is stored under. */
    public static SecretNameFor(realm: string, name: string): string
    {
        if (realm.includes(AzureRealmSecretStore.RealmSeparator)) throw new Error(AzureRealmSecretStore.SeparatorInRealm)
        return realm + AzureRealmSecretStore.RealmSeparator + name
    }

    /** Whether every realm secret name of `realm` fits Key Vault's names (`<realm>--<name>`, at most 127). */
    public static FitsRealm(realm: string): boolean
    {
        const A = AzureRealmSecretStore
        return !realm.includes(A.RealmSeparator) && realm.length + A.RealmSeparator.length + A.MaxRealmSecretName <= A.MaxNameLength
    }

    /** At start: the projected token is readable (nothing is sent to Entra or the vault). */
    public async Verify(): Promise<void>
    {
        await this.context.ReadToken(RealmSecretsOption.Azure)
    }

    public async Get(key: string): Promise<string | null>
    {
        const name = RealmSecretName.TryParse(key)
        if (name === undefined) return null
        await this.context.ReadToken(RealmSecretsOption.Azure)
        const secret = await this.Guarded(() => this.client.getSecret(this.NameOf(name.Name), name.Version === undefined ? {} : { version: name.Version }), true)
        return secret?.value ?? null
    }

    public async Put(key: string, secret: string): Promise<void>
    {
        const A = AzureRealmSecretStore
        const name = this.NameOf(RealmSecretName.ForWrite(key).Name)
        await this.context.ReadToken(RealmSecretsOption.Azure)
        try
        {
            await this.client.setSecret(name, secret)
        }
        catch (error)
        {
            if (A.StatusOf(error) !== A.Conflict) throw A.Typed(error)
            // The name is held by a soft-deleted secret: recover it, then write the new version.
            await this.Guarded(async () => (await this.client.beginRecoverDeletedSecret(name, A.PollOptions)).pollUntilDone(), false)
            await this.Guarded(() => this.client.setSecret(name, secret), false)
        }
    }

    public async Delete(key: string): Promise<void>
    {
        const name = this.NameOf(RealmSecretName.ForWrite(key).Name)
        await this.context.ReadToken(RealmSecretsOption.Azure)
        const deleted = await this.Guarded(async () => (await this.client.beginDeleteSecret(name, AzureRealmSecretStore.PollOptions)).pollUntilDone(), true)
        if (deleted === undefined) return
        try
        {
            await this.client.purgeDeletedSecret(name)
        }
        catch (error)
        {
            // No purge permission (or purge protection): the secret stays soft-deleted, recovered by a later write.
            if (AzureRealmSecretStore.StatusOf(error) !== AzureRealmSecretStore.Forbidden) throw AzureRealmSecretStore.Typed(error)
        }
    }

    private NameOf(name: string): string
    {
        return AzureRealmSecretStore.SecretNameFor(this.context.RealmId, name)
    }

    private async Guarded<T>(work: () => Promise<T>, absentIsNull: boolean): Promise<T | undefined>
    {
        try
        {
            return await work()
        }
        catch (error)
        {
            if (absentIsNull && AzureRealmSecretStore.StatusOf(error) === AzureRealmSecretStore.NotFound) return undefined
            throw AzureRealmSecretStore.Typed(error)
        }
    }

    private static Typed(error: unknown): SecretsHomeUnavailableError
    {
        const A = AzureRealmSecretStore
        if (error instanceof SecretsHomeUnavailableError) return error
        const name = (error as { name?: unknown } | null)?.name
        if (typeof name === 'string' && A.CredentialErrors.has(name))
        {
            // Entra refused the assertion, unless the chain shows it was not reached (or failed: a 5xx).
            return new SecretsHomeUnavailableError(RealmSecretsOption.Azure, A.NotReached(error) ? SecretsHomeFailure.Unreachable : SecretsHomeFailure.ExchangeRefused)
        }
        const status = A.StatusOf(error)
        if (status === A.Forbidden) return new SecretsHomeUnavailableError(RealmSecretsOption.Azure, SecretsHomeFailure.PermissionDenied)
        if (status === A.Unauthorized) return new SecretsHomeUnavailableError(RealmSecretsOption.Azure, SecretsHomeFailure.ExchangeRefused)
        if (status === A.NotFound) return new SecretsHomeUnavailableError(RealmSecretsOption.Azure, SecretsHomeFailure.NotFound)
        return new SecretsHomeUnavailableError(RealmSecretsOption.Azure, SecretsHomeFailure.Unreachable)
    }

    // A network failure or a server error anywhere in the error's cause chain (MSAL wraps what the transport threw).
    private static NotReached(error: unknown): boolean
    {
        const A = AzureRealmSecretStore
        let current: unknown = error
        for (let depth = 0; depth < A.MaxCauseDepth && current !== null && typeof current === 'object'; depth++)
        {
            const fields = current as { code?: unknown, errorCode?: unknown, statusCode?: unknown, cause?: unknown }
            if (typeof fields.code === 'string' && A.NetworkCodes.has(fields.code)) return true
            if (typeof fields.errorCode === 'string' && A.NetworkErrorCodes.has(fields.errorCode)) return true
            if (typeof fields.statusCode === 'number' && fields.statusCode >= A.ServerError) return true
            current = fields.cause
        }
        return false
    }

    private static StatusOf(error: unknown): number | undefined
    {
        const status = (error as { statusCode?: unknown } | null)?.statusCode
        return typeof status === 'number' ? status : undefined
    }
}

/** Where the Azure home sends its requests; tests hand it a recorded fake's HTTP client. */
export class AzureTransport
{
    public static readonly Network = new AzureTransport(undefined)

    public constructor(public readonly HttpClient: HttpClient | undefined)
    {
        Object.freeze(this)
    }
}

/**
 * The Azure option's secrets home (`IRealmSecretsHomeFactory`). Settings, identifiers only: `tenantId` and `clientId`
 * (the Entra app or user-assigned identity federated with the cluster's issuer), `vaultUrl` (the realm's vault) and
 * optional `authorityHost` (a sovereign cloud's login host; default the public cloud's).
 */
export class AzureWorkloadIdentity implements IRealmSecretsHomeFactory
{
    public static readonly TenantId = 'tenantId'
    public static readonly ClientId = 'clientId'
    public static readonly VaultUrl = 'vaultUrl'
    public static readonly AuthorityHost = 'authorityHost'
    public static readonly PublicAuthorityHost = 'https://login.microsoftonline.com'
    private static readonly Guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    private static readonly TenantForm = 'an Entra tenant id (a lowercase GUID)'
    private static readonly ClientForm = 'an Entra client id (a lowercase GUID)'
    /** Key Vault names: 3-24 characters, a letter first, letters, digits and single "-", not "-" last. */
    private static readonly VaultPattern = /^https:\/\/[a-z](?!.*--)[a-z0-9-]{1,22}[a-z0-9]\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net)\/?$/
    private static readonly VaultForm = 'a Key Vault URL (https://<vault>.vault.azure.net)'
    private static readonly AuthorityPattern = /^https:\/\/login\.(microsoftonline\.com|chinacloudapi\.cn|microsoftonline\.us)\/?$/
    private static readonly AuthorityForm = 'an Entra login host'
    private static readonly RealmTooLong = 'the realm id does not fit Key Vault secret names (<realm>--<name>, at most 127 characters, no "--" in the realm id)'

    public readonly Option = RealmSecretsOption.Azure
    public readonly Settings: readonly RealmSecretsSettingRule[] = [
        new RealmSecretsSettingRule(AzureWorkloadIdentity.TenantId, AzureWorkloadIdentity.Guid, true, AzureWorkloadIdentity.TenantForm),
        new RealmSecretsSettingRule(AzureWorkloadIdentity.ClientId, AzureWorkloadIdentity.Guid, true, AzureWorkloadIdentity.ClientForm),
        new RealmSecretsSettingRule(AzureWorkloadIdentity.VaultUrl, AzureWorkloadIdentity.VaultPattern, true, AzureWorkloadIdentity.VaultForm),
        new RealmSecretsSettingRule(AzureWorkloadIdentity.AuthorityHost, AzureWorkloadIdentity.AuthorityPattern, false, AzureWorkloadIdentity.AuthorityForm),
    ]

    public constructor(private readonly transport: AzureTransport = AzureTransport.Network)
    {
    }

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<IRealmSecretStore>
    {
        const A = AzureWorkloadIdentity
        if (!AzureRealmSecretStore.FitsRealm(context.RealmId)) return Promise.reject(new RealmSecretsSettingsError(A.RealmTooLong))
        const httpClient = this.transport.HttpClient
        const credential = new ClientAssertionCredential(
            settings.Get(A.TenantId)!,
            settings.Get(A.ClientId)!,
            () => context.ReadToken(RealmSecretsOption.Azure),
            { authorityHost: settings.Get(A.AuthorityHost) ?? A.PublicAuthorityHost, ...(httpClient === undefined ? {} : { httpClient }) })
        const client = new SecretClient(settings.Get(A.VaultUrl)!, credential, { ...(httpClient === undefined ? {} : { httpClient }), retryOptions: { maxRetries: 0 } })
        return Promise.resolve(new AzureRealmSecretStore(client, context))
    }
}
