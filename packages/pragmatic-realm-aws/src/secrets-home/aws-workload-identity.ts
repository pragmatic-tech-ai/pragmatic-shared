import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { fromWebToken } from '@aws-sdk/credential-provider-web-identity'
import { RealmSecretName, RealmSecretsOption, RealmSecretsSettingRule, SecretsHomeFailure, SecretsHomeUnavailableError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IRealmSecretStore, IRealmSecretsHomeFactory, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

/** The AWS endpoints an AWS secrets home talks to, per region; tests point them at recorded fakes. */
export class AwsEndpoints
{
    private static readonly Scheme = 'https://'
    private static readonly StsHost = 'sts.'
    private static readonly SecretsHost = 'secretsmanager.'
    private static readonly Suffix = '.amazonaws.com'
    private static readonly ChinaSuffix = '.amazonaws.com.cn'
    private static readonly ChinaPartition = 'arn:aws-cn:'

    /** The regional public endpoints of the role's partition. */
    public static readonly Aws = new AwsEndpoints(undefined, undefined)

    public constructor(private readonly sts: string | undefined, private readonly secretsManager: string | undefined)
    {
        Object.freeze(this)
    }

    public StsFor(region: string, roleArn: string): string
    {
        return this.sts ?? AwsEndpoints.Scheme + AwsEndpoints.StsHost + region + AwsEndpoints.SuffixOf(roleArn)
    }

    public SecretsManagerFor(region: string, roleArn: string): string
    {
        return this.secretsManager ?? AwsEndpoints.Scheme + AwsEndpoints.SecretsHost + region + AwsEndpoints.SuffixOf(roleArn)
    }

    private static SuffixOf(roleArn: string): string
    {
        return roleArn.startsWith(AwsEndpoints.ChinaPartition) ? AwsEndpoints.ChinaSuffix : AwsEndpoints.Suffix
    }
}

/**
 * A realm's secrets in AWS Secrets Manager, as a web identity: the client's credentials come from
 * `AssumeRoleWithWebIdentity` with the component's projected service-account token (read on every refresh) and the
 * realm option's role ARN, at explicit regional endpoints. The SDK's default chain (environment keys, profiles, the
 * container and instance metadata services, `AWS_WEB_IDENTITY_TOKEN_FILE`) is never consulted. Secret names are
 * `pragmatic/<realm>/<name>`, so a role's policy on `secret:pragmatic/<realm>/*` confines a realm's workloads. They are
 * always addressed by their full name, never a partial ARN, so a name ending in "-" and six characters is unambiguous.
 * Deletes are immediate (no recovery window); a create right after one waits while the name is still being released.
 *
 * Absent secrets (and absent pinned versions) read as null. Everything else fails typed, never with AWS's text.
 */
export class AwsRealmSecretStore implements IRealmSecretStore
{
    private static readonly NamePrefix = 'pragmatic/'
    private static readonly Separator = '/'
    private static readonly NotFound = 'ResourceNotFoundException'
    private static readonly Denied: ReadonlySet<string> = new Set(['AccessDeniedException', 'AccessDenied'])
    private static readonly Refused: ReadonlySet<string> = new Set(['UnrecognizedClientException', 'InvalidSignatureException', 'ExpiredTokenException', 'IncompleteSignature', 'InvalidClientTokenId'])
    private static readonly ForbiddenStatus = 403
    private static readonly Exists = 'ResourceExistsException'
    private static readonly PendingDeletion = 'InvalidRequestException'
    /** A name a force delete is still releasing: a create is retried this many times (CreateRetryMs apart). */
    public static readonly CreateAttempts = 5
    public static readonly CreateRetryMs = 1000
    /** How Secrets Manager says a name is still being released (the only InvalidRequestException retried). */
    private static readonly ScheduledForDeletion = /scheduled for deletion/i

    public constructor(private readonly client: SecretsManagerClient, private readonly context: WorkloadContext, private readonly createRetryMs: number = AwsRealmSecretStore.CreateRetryMs)
    {
    }

    /** The Secrets Manager name a realm secret is stored under. */
    public static SecretNameFor(realm: string, name: string): string
    {
        return AwsRealmSecretStore.NamePrefix + realm + AwsRealmSecretStore.Separator + name
    }

    /** At start: the projected token is readable (nothing is sent to AWS). */
    public async Verify(): Promise<void>
    {
        await this.context.ReadToken(RealmSecretsOption.Aws)
    }

    public async Get(key: string): Promise<string | null>
    {
        const name = RealmSecretName.TryParse(key)
        if (name === undefined) return null
        await this.context.ReadToken(RealmSecretsOption.Aws)
        const input = { SecretId: this.NameOf(name.Name), ...(name.Version === undefined ? {} : { VersionId: name.Version }) }
        const output = await this.Guarded(() => this.client.send(new GetSecretValueCommand(input)), true)
        return output?.SecretString ?? null
    }

    public async Put(key: string, secret: string): Promise<void>
    {
        const id = this.NameOf(RealmSecretName.ForWrite(key).Name)
        await this.context.ReadToken(RealmSecretsOption.Aws)
        if (await this.PutValue(id, secret)) return
        for (let attempt = 1; ; attempt++)
        {
            try
            {
                await this.client.send(new CreateSecretCommand({ Name: id, SecretString: secret }))
                return
            }
            catch (error)
            {
                const A = AwsRealmSecretStore
                const name = (error as { name?: unknown } | null)?.name
                // Created meanwhile by another writer: the value goes in as its next version.
                if (name === A.Exists && await this.PutValue(id, secret)) return
                if (!A.IsPendingDeletion(error) || attempt >= A.CreateAttempts) throw A.Typed(error)
            }
            await new Promise<void>(resolve => setTimeout(resolve, this.createRetryMs))
        }
    }

    // A new version of an existing secret; false when there is no such secret.
    private async PutValue(id: string, secret: string): Promise<boolean>
    {
        return await this.Guarded(() => this.client.send(new PutSecretValueCommand({ SecretId: id, SecretString: secret })), true) !== undefined
    }

    public async Delete(key: string): Promise<void>
    {
        const id = this.NameOf(RealmSecretName.ForWrite(key).Name)
        await this.context.ReadToken(RealmSecretsOption.Aws)
        await this.Guarded(() => this.client.send(new DeleteSecretCommand({ SecretId: id, ForceDeleteWithoutRecovery: true })), true)
    }

    private NameOf(name: string): string
    {
        return AwsRealmSecretStore.SecretNameFor(this.context.RealmId, name)
    }

    private async Guarded<T>(work: () => Promise<T>, absentIsUndefined: boolean): Promise<T | undefined>
    {
        const A = AwsRealmSecretStore
        try
        {
            return await work()
        }
        catch (error)
        {
            if (absentIsUndefined && (error as { name?: unknown } | null)?.name === A.NotFound) return undefined
            throw A.Typed(error)
        }
    }

    // The message is read for the one fact, never kept or shown.
    private static IsPendingDeletion(error: unknown): boolean
    {
        const fields = error as { name?: unknown, message?: unknown } | null
        return fields?.name === AwsRealmSecretStore.PendingDeletion && typeof fields.message === 'string' && AwsRealmSecretStore.ScheduledForDeletion.test(fields.message)
    }

    private static Typed(error: unknown): SecretsHomeUnavailableError
    {
        const A = AwsRealmSecretStore
        if (error instanceof SecretsHomeUnavailableError) return error
        const name = (error as { name?: unknown } | null)?.name
        const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode
        if (typeof name === 'string' && A.Denied.has(name)) return new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.PermissionDenied)
        if (typeof name === 'string' && A.Refused.has(name)) return new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.ExchangeRefused)
        if (status === A.ForbiddenStatus) return new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.PermissionDenied)
        if (name === A.NotFound) return new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.NotFound)
        return new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.Unreachable)
    }
}

/**
 * The AWS option's secrets home (`IRealmSecretsHomeFactory`). Settings, identifiers only: `region`, `roleArn` (the IAM
 * role whose trust policy names the cluster's OIDC provider) and optional `sessionName` (default the component's name).
 */
export class AwsWorkloadIdentity implements IRealmSecretsHomeFactory
{
    public static readonly Region = 'region'
    public static readonly RoleArn = 'roleArn'
    public static readonly SessionName = 'sessionName'
    private static readonly MaxAttempts = 1
    private static readonly BadRequest = 400
    private static readonly ServerError = 500
    private static readonly RegionPattern = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/
    private static readonly RegionForm = 'an AWS region (eu-central-1)'
    private static readonly RoleArnPattern = /^arn:aws(-cn|-us-gov)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/
    private static readonly RoleArnForm = 'an IAM role ARN (arn:aws:iam::<account>:role/<name>)'
    private static readonly SessionPattern = /^[A-Za-z][A-Za-z0-9+=,.@-]{1,31}$/
    private static readonly SessionForm = 'a role session name'

    public readonly Option = RealmSecretsOption.Aws
    public readonly Settings: readonly RealmSecretsSettingRule[] = [
        new RealmSecretsSettingRule(AwsWorkloadIdentity.Region, AwsWorkloadIdentity.RegionPattern, true, AwsWorkloadIdentity.RegionForm),
        new RealmSecretsSettingRule(AwsWorkloadIdentity.RoleArn, AwsWorkloadIdentity.RoleArnPattern, true, AwsWorkloadIdentity.RoleArnForm),
        new RealmSecretsSettingRule(AwsWorkloadIdentity.SessionName, AwsWorkloadIdentity.SessionPattern, false, AwsWorkloadIdentity.SessionForm),
    ]

    public constructor(private readonly endpoints: AwsEndpoints = AwsEndpoints.Aws, private readonly createRetryMs: number = AwsRealmSecretStore.CreateRetryMs)
    {
    }

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<IRealmSecretStore>
    {
        const A = AwsWorkloadIdentity
        const region = settings.Get(A.Region)!
        const roleArn = settings.Get(A.RoleArn)!
        const sessionName = settings.Get(A.SessionName) ?? context.Component
        const sts = this.endpoints.StsFor(region, roleArn)
        const credentials = async (): Promise<Awaited<ReturnType<ReturnType<typeof fromWebToken>>>> =>
        {
            const token = await context.ReadToken(RealmSecretsOption.Aws)
            try
            {
                return await fromWebToken({ roleArn, roleSessionName: sessionName, webIdentityToken: token, clientConfig: { region, endpoint: sts, maxAttempts: A.MaxAttempts } })()
            }
            catch (error)
            {
                // STS refused (a 4xx), or failed or was not reached (a 5xx, no answer); its text is never kept.
                const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode
                const refused = typeof status === 'number' && status >= A.BadRequest && status < A.ServerError
                throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, refused ? SecretsHomeFailure.ExchangeRefused : SecretsHomeFailure.Unreachable)
            }
        }
        const client = new SecretsManagerClient({ region, endpoint: this.endpoints.SecretsManagerFor(region, roleArn), credentials, maxAttempts: A.MaxAttempts })
        return Promise.resolve(new AwsRealmSecretStore(client, context, this.createRetryMs))
    }
}
