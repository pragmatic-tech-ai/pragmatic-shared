import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { fromWebToken } from '@aws-sdk/credential-provider-web-identity'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmSecretName, RealmSecretsOption, RealmSecretsSettingRule, SecretsHomeFailure, SecretsHomeUnavailableError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { IRealmSecretsHomeFactory, RealmSecretsSettings, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

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
 * `pragmatic/<realm>/<name>`, so a role's policy on `secret:pragmatic/<realm>/*` confines a realm's workloads.
 *
 * Absent secrets (and absent pinned versions) read as null. Everything else fails typed, never with AWS's text.
 */
export class AwsRealmSecretStore implements ISecretStore
{
    private static readonly NamePrefix = 'pragmatic/'
    private static readonly Separator = '/'
    private static readonly NotFound = 'ResourceNotFoundException'
    private static readonly Denied: ReadonlySet<string> = new Set(['AccessDeniedException', 'AccessDenied'])
    private static readonly Refused: ReadonlySet<string> = new Set(['UnrecognizedClientException', 'InvalidSignatureException', 'ExpiredTokenException', 'IncompleteSignature', 'InvalidClientTokenId'])
    private static readonly ForbiddenStatus = 403

    public constructor(private readonly client: SecretsManagerClient, private readonly context: WorkloadContext)
    {
    }

    /** The Secrets Manager name a realm secret is stored under. */
    public static SecretNameFor(realm: string, name: string): string
    {
        return AwsRealmSecretStore.NamePrefix + realm + AwsRealmSecretStore.Separator + name
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
        const put = await this.Guarded(() => this.client.send(new PutSecretValueCommand({ SecretId: id, SecretString: secret })), true)
        if (put === undefined)
        {
            await this.Guarded(() => this.client.send(new CreateSecretCommand({ Name: id, SecretString: secret })), false)
        }
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
            if (error instanceof SecretsHomeUnavailableError) throw error
            const name = (error as { name?: unknown } | null)?.name
            if (absentIsUndefined && name === A.NotFound) return undefined
            const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode
            if (typeof name === 'string' && A.Denied.has(name)) throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.PermissionDenied)
            if (typeof name === 'string' && A.Refused.has(name)) throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.ExchangeRefused)
            if (status === A.ForbiddenStatus) throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.PermissionDenied)
            if (name === A.NotFound) throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.NotFound)
            throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, SecretsHomeFailure.Unreachable)
        }
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

    public readonly Option = RealmSecretsOption.Aws
    public readonly Settings: readonly RealmSecretsSettingRule[] = [
        new RealmSecretsSettingRule(AwsWorkloadIdentity.Region, /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/, true, 'an AWS region (eu-central-1)'),
        new RealmSecretsSettingRule(AwsWorkloadIdentity.RoleArn, /^arn:aws(-cn|-us-gov)?:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/, true, 'an IAM role ARN (arn:aws:iam::<account>:role/<name>)'),
        new RealmSecretsSettingRule(AwsWorkloadIdentity.SessionName, /^[A-Za-z0-9+=,.@-]{2,64}$/, false, 'a role session name'),
    ]

    public constructor(private readonly endpoints: AwsEndpoints = AwsEndpoints.Aws)
    {
    }

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<ISecretStore>
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
                // The service answered (a refusal) or did not (unreachable); its text is never kept.
                const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode
                throw new SecretsHomeUnavailableError(RealmSecretsOption.Aws, typeof status === 'number' ? SecretsHomeFailure.ExchangeRefused : SecretsHomeFailure.Unreachable)
            }
        }
        const client = new SecretsManagerClient({ region, endpoint: this.endpoints.SecretsManagerFor(region, roleArn), credentials, maxAttempts: A.MaxAttempts })
        return Promise.resolve(new AwsRealmSecretStore(client, context))
    }
}
