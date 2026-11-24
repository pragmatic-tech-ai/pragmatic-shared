import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmSecretsHome, RealmSecretsOption, RealmSecretsSettings, RealmSecretsSettingsError, SecretsHomeFailure, SecretsHomeUnavailableError, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { RecordedEndpoints, RecordedResponse, type RecordedRequest } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AwsEndpoints, AwsRealmSecretStore, AwsWorkloadIdentity } from '../aws-workload-identity.js'

const RoleArn = 'arn:aws:iam::123456789012:role/pragmatic-realm-acme'
const ProjectToken = 'projected.service-account.jwt'

/** Recorded fakes of STS (AssumeRoleWithWebIdentity, query protocol) and Secrets Manager (JSON 1.1). */
class AwsFake
{
    public readonly Sts = new RecordedEndpoints()
    public readonly Secrets = new RecordedEndpoints()
    public readonly Metadata = new RecordedEndpoints()
    public readonly Values = new Map<string, string[]>()
    public RefuseExchange = false
    public FailExchange = false
    public DenySecrets = false
    /** Creates refused while a deleted name is still being released. */
    public PendingDeletions = 0
    /** A writer that creates the secret between this one's put and create. */
    public RacingCreate: string | undefined
    /** One create refused as invalid for another reason (never retried). */
    public OtherInvalid = false

    public async Start(): Promise<AwsFake>
    {
        this.Sts.Route('POST', /^\//, () => this.FailExchange
            ? new RecordedResponse(503, '<ErrorResponse><Error><Type>Receiver</Type><Code>ServiceUnavailable</Code><Message>down</Message></Error><RequestId>r</RequestId></ErrorResponse>', 'text/xml')
            : this.RefuseExchange
            ? new RecordedResponse(400, '<ErrorResponse><Error><Type>Sender</Type><Code>InvalidIdentityToken</Code><Message>Incorrect token audience secret-looking detail</Message></Error><RequestId>r</RequestId></ErrorResponse>', 'text/xml')
            : new RecordedResponse(200, '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAFAKEFAKEFAKEFAKE</AccessKeyId><SecretAccessKey>fake-secret</SecretAccessKey><SessionToken>fake-session</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials><SubjectFromWebIdentityToken>system:serviceaccount:pragmatic-system:pragmatic-tenant-idp</SubjectFromWebIdentityToken><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/pragmatic-realm-acme/s</Arn><AssumedRoleId>AROA:s</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>', 'text/xml'))
        this.Secrets.Route('POST', /^\//, request => this.Answer(request))
        await this.Sts.Start()
        await this.Secrets.Start()
        await this.Metadata.Start()
        return this
    }

    public get Endpoints(): AwsEndpoints
    {
        return new AwsEndpoints(this.Sts.Origin, this.Secrets.Origin)
    }

    public async Stop(): Promise<void>
    {
        await this.Sts.Stop()
        await this.Secrets.Stop()
        await this.Metadata.Stop()
    }

    private Answer(request: RecordedRequest): RecordedResponse
    {
        const error = (type: string): RecordedResponse => new RecordedResponse(400, JSON.stringify({ __type: type, message: 'detail secret-looking' }), 'application/x-amz-json-1.1')
        const ok = (body: unknown): RecordedResponse => new RecordedResponse(200, JSON.stringify(body), 'application/x-amz-json-1.1')
        if (this.DenySecrets) return error('AccessDeniedException')
        const target = request.Headers['x-amz-target'] ?? ''
        const body = request.Json as Record<string, string>
        if (target.endsWith('.GetSecretValue'))
        {
            const versions = this.Values.get(body.SecretId!)
            const value = versions === undefined ? undefined : body.VersionId === undefined ? versions[versions.length - 1] : versions[Number(body.VersionId.replace(/^v/, '')) - 1]
            return value === undefined ? error('ResourceNotFoundException') : ok({ Name: body.SecretId, SecretString: value, VersionId: 'v' + versions!.length })
        }
        if (target.endsWith('.PutSecretValue'))
        {
            const versions = this.Values.get(body.SecretId!)
            if (versions === undefined) return error('ResourceNotFoundException')
            versions.push(body.SecretString!)
            return ok({ Name: body.SecretId })
        }
        if (target.endsWith('.CreateSecret'))
        {
            if (this.PendingDeletions > 0)
            {
                this.PendingDeletions -= 1
                return new RecordedResponse(400, JSON.stringify({ __type: 'InvalidRequestException', message: "You can't create this secret because a secret with this name is already scheduled for deletion." }), 'application/x-amz-json-1.1')
            }
            if (this.OtherInvalid)
            {
                this.OtherInvalid = false
                return error('InvalidRequestException')
            }
            if (this.RacingCreate !== undefined)
            {
                this.Values.set(body.Name!, [this.RacingCreate])
                this.RacingCreate = undefined
            }
            if (this.Values.has(body.Name!)) return error('ResourceExistsException')
            this.Values.set(body.Name!, [body.SecretString!])
            return ok({ Name: body.Name })
        }
        if (target.endsWith('.DeleteSecret'))
        {
            return this.Values.delete(body.SecretId!) ? ok({ Name: body.SecretId }) : error('ResourceNotFoundException')
        }
        return error('InvalidRequestException')
    }
}

class Scene
{
    public static async With(body: (fake: AwsFake, tokenFile: string, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'aws-wi-'))
        const fake = await new AwsFake().Start()
        try
        {
            const tokenFile = join(dir, 'token')
            await writeFile(tokenFile, ProjectToken + '\n')
            await body(fake, tokenFile, dir)
        }
        finally
        {
            await fake.Stop()
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Open(fake: AwsFake, tokenFile: string, values: Record<string, string> = {}): Promise<ISecretStore>
    {
        const home = new RealmSecretsHome([new AwsWorkloadIdentity(fake.Endpoints, 1)])
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Aws, { region: 'eu-central-1', roleArn: RoleArn, ...values })
        return home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-idp', tokenFile))
    }

    public static Failure(code: SecretsHomeFailure): (error: unknown) => boolean
    {
        return error =>
        {
            assert.ok(error instanceof SecretsHomeUnavailableError, String(error))
            assert.equal(error.Option, RealmSecretsOption.Aws)
            assert.equal(error.Code, code)
            assert.doesNotMatch(error.message, /secret-looking|audience/)
            return true
        }
    }
}

test('aws: exchanges the projected token and reads a secret', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        fake.Values.set(AwsRealmSecretStore.SecretNameFor('acme', 'probe'), ['first', 'second'])
        assert.equal(await store.Get('probe'), 'second')
        assert.equal(await store.Get('probe@v1'), 'first')
        const exchange = fake.Sts.Requests[0]!.Form
        assert.equal(exchange.get('Action'), 'AssumeRoleWithWebIdentity')
        assert.equal(exchange.get('WebIdentityToken'), ProjectToken, 'the projected token is what was presented')
        assert.equal(exchange.get('RoleArn'), RoleArn)
        assert.equal(exchange.get('RoleSessionName'), 'pragmatic-tenant-idp')
        const read = fake.Secrets.Requests[0]!
        assert.match(read.Headers.authorization ?? '', /Credential=ASIAFAKEFAKEFAKEFAKE\//, 'signed with the exchanged credentials')
        assert.equal((read.Json as { SecretId: string }).SecretId, 'pragmatic/acme/probe', 'secret names carry the realm prefix')
    })
})

test('aws: writes create then add versions; deletes are immediate and idempotent', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile, { sessionName: 'console-1' })
        await store.Put('probe', 'one')
        await store.Put('probe', 'two')
        assert.equal(await store.Get('probe'), 'two')
        await store.Delete('probe')
        await store.Delete('probe')
        assert.equal(await store.Get('probe'), null)
        assert.equal(fake.Sts.Requests[0]!.Form.get('RoleSessionName'), 'console-1')
        const deletion = fake.Secrets.Requests.find(request => (request.Headers['x-amz-target'] ?? '').endsWith('.DeleteSecret'))!
        assert.equal((deletion.Json as { ForceDeleteWithoutRecovery: boolean }).ForceDeleteWithoutRecovery, true)
    })
})

test('aws: a refused exchange is exchange-refused without cloud text', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.RefuseExchange = true
        const store = await Scene.Open(fake, tokenFile)
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.ExchangeRefused))
        assert.equal(fake.Secrets.Requests.length, 0)
    })
})

test('aws: a create racing another writer adds a version; a name still being released is retried', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        fake.RacingCreate = 'other-writer'
        await store.Put('probe', 'mine')
        assert.deepEqual(fake.Values.get('pragmatic/acme/probe'), ['other-writer', 'mine'])
        await store.Delete('probe')
        fake.PendingDeletions = 1
        await store.Put('probe', 'again')
        assert.deepEqual(fake.Values.get('pragmatic/acme/probe'), ['again'])
        fake.PendingDeletions = AwsRealmSecretStore.CreateAttempts
        await store.Delete('probe')
        await assert.rejects(store.Put('probe', 'never'), Scene.Failure(SecretsHomeFailure.Unreachable))
        fake.PendingDeletions = 0
        fake.OtherInvalid = true
        const before = fake.Secrets.Requests.length
        await assert.rejects(store.Put('probe', 'invalid'), Scene.Failure(SecretsHomeFailure.Unreachable))
        assert.equal(fake.Secrets.To(/./).slice(before).filter(request => (request.Headers['x-amz-target'] ?? '').endsWith('.CreateSecret')).length, 1, 'another invalid request is not retried')
    })
})

test('aws: an STS that fails (5xx) is unreachable, not a refused exchange', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.FailExchange = true
        const store = await Scene.Open(fake, tokenFile)
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.Unreachable))
    })
})

test('aws: with AWS_* variables and a metadata server present, the exchanged credentials sign, and nothing ambient is used', async () =>
{
    await Scene.With(async (fake, tokenFile, dir) =>
    {
        const ambientToken = join(dir, 'ambient-token')
        await writeFile(ambientToken, 'ambient.jwt')
        const saved = { ...process.env }
        Object.assign(process.env, {
            AWS_ACCESS_KEY_ID: 'AKIAAMBIENTAMBIENTAM', AWS_SECRET_ACCESS_KEY: 'ambient', AWS_WEB_IDENTITY_TOKEN_FILE: ambientToken, AWS_ROLE_ARN: 'arn:aws:iam::999999999999:role/ambient',
            AWS_CONTAINER_CREDENTIALS_FULL_URI: fake.Metadata.Origin + '/creds', AWS_EC2_METADATA_SERVICE_ENDPOINT: fake.Metadata.Origin, AWS_ENDPOINT_URL: fake.Metadata.Origin, AWS_REGION: 'us-east-1',
        })
        try
        {
            const store = await Scene.Open(fake, tokenFile)
            fake.Values.set('pragmatic/acme/probe', ['value'])
            assert.equal(await store.Get('probe'), 'value')
            assert.equal(fake.Sts.Requests[0]!.Form.get('WebIdentityToken'), ProjectToken)
            assert.equal(fake.Sts.Requests[0]!.Form.get('RoleArn'), RoleArn)
            assert.match(fake.Secrets.Requests[0]!.Headers.authorization ?? '', /Credential=ASIAFAKEFAKEFAKEFAKE\/[0-9]+\/eu-central-1\//)
            assert.equal(fake.Metadata.Requests.length, 0)
        }
        finally
        {
            process.env = saved
        }
    })
})

test('aws: Verify reads the projected token only', async () =>
{
    await Scene.With(async (fake, tokenFile, dir) =>
    {
        await (await Scene.Open(fake, tokenFile) as AwsRealmSecretStore).Verify()
        await assert.rejects((await Scene.Open(fake, join(dir, 'no-token')) as AwsRealmSecretStore).Verify(), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
        assert.equal(fake.Sts.Requests.length + fake.Secrets.Requests.length, 0)
    })
})

test('aws: a missing secret is not-found (reads absent); a denied one is permission-denied', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        assert.equal(await store.Get('absent'), null)
        fake.DenySecrets = true
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.PermissionDenied))
    })
})

test('aws: no ambient fallback: with AWS_* variables and a metadata server present, a missing token is token-unreadable', async () =>
{
    await Scene.With(async (fake, _tokenFile, dir) =>
    {
        const ambientToken = join(dir, 'ambient-token')
        await writeFile(ambientToken, 'ambient.jwt')
        const saved = { ...process.env }
        Object.assign(process.env, {
            AWS_ACCESS_KEY_ID: 'AKIAAMBIENTAMBIENTAM', AWS_SECRET_ACCESS_KEY: 'ambient', AWS_WEB_IDENTITY_TOKEN_FILE: ambientToken, AWS_ROLE_ARN: RoleArn,
            AWS_CONTAINER_CREDENTIALS_FULL_URI: fake.Metadata.Origin + '/creds', AWS_EC2_METADATA_SERVICE_ENDPOINT: fake.Metadata.Origin, AWS_ENDPOINT_URL: fake.Metadata.Origin, AWS_REGION: 'us-east-1',
        })
        try
        {
            const store = await Scene.Open(fake, join(dir, 'no-token'))
            await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            await assert.rejects(store.Put('probe', 'v'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            assert.equal(fake.Metadata.Requests.length, 0, 'the metadata services are never called')
            assert.equal(fake.Sts.Requests.length + fake.Secrets.Requests.length, 0, 'nothing is sent without the projected token')
        }
        finally
        {
            process.env = saved
        }
    })
})

test('aws: a key-shaped setting is refused by the descriptor', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        await assert.rejects(Scene.Open(fake, tokenFile, { accessKeyId: 'AKIAABCDEFGHIJKLMNOP' }), (error: Error) => error instanceof RealmSecretsSettingsError && /ACCESS_KEY_ID is refused/.test(error.message))
        await assert.rejects(Scene.Open(fake, tokenFile, { secretAccessKey: 'x' }), /SECRET_ACCESS_KEY is refused/)
        await assert.rejects(Scene.Open(fake, tokenFile, { sessionName: 'AKIAABCDEFGHIJKLMNOP' }), /SESSION_NAME holds a key-shaped value/)
        // A 40-character secret access key does not have a session name's form (letter-led, at most 32).
        await assert.rejects(Scene.Open(fake, tokenFile, { sessionName: 'Ab1+'.repeat(10) }), /SESSION_NAME does not have the form/)
    })
})
