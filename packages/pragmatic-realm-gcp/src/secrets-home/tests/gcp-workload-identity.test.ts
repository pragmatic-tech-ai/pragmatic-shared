import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmSecretsHome, RealmSecretsOption, RealmSecretsSettings, RealmSecretsSettingsError, SecretsHomeFailure, SecretsHomeUnavailableError, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { RecordedEndpoints, RecordedResponse } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { GcpEndpoints, GcpRealmSecretStore, GcpWorkloadIdentity } from '../gcp-workload-identity.js'

const Audience = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/pragmatic-hives/providers/pragmatic-customer'
const Email = 'realm-acme@pragmatic-ops.iam.gserviceaccount.com'
const ProjectToken = 'projected.service-account.jwt'

class GoogleFake
{
    public readonly Endpoints = new RecordedEndpoints()
    public readonly Metadata = new RecordedEndpoints()
    public readonly Secrets = new Map<string, string[]>()
    public RefuseExchange = false
    public DenySecrets = false

    public async Start(): Promise<GoogleFake>
    {
        const E = this.Endpoints
        E.Route('POST', /^\/v1\/token$/, () => this.RefuseExchange
            ? RecordedResponse.Json(400, { error: 'invalid_grant', error_description: 'The audience in the token does not match: secret-looking detail' })
            : RecordedResponse.Json(200, { access_token: 'federated-token', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600 }))
        E.Route('POST', /^\/v1\/projects\/-\/serviceAccounts\/[^/]+:generateAccessToken$/, request =>
            request.Headers.authorization === 'Bearer federated-token'
                ? RecordedResponse.Json(200, { accessToken: 'impersonated-token', expireTime: new Date(Date.now() + 3600_000).toISOString() })
                : RecordedResponse.Json(401, { error: { code: 401 } }))
        E.Route('GET', /^\/v1\/projects\/pragmatic-ops\/secrets\/[^/]+\/versions\/[^/]+:access$/, request =>
        {
            if (this.DenySecrets) return RecordedResponse.Json(403, { error: { code: 403, message: 'Permission denied on resource projects/pragmatic-ops' } })
            const [, id, version] = /secrets\/([^/]+)\/versions\/([^/:]+):access$/.exec(request.Path)!
            const versions = this.Secrets.get(id!)
            const value = versions === undefined ? undefined : version === 'latest' ? versions[versions.length - 1] : versions[Number(version) - 1]
            return value === undefined ? RecordedResponse.Json(404, { error: { code: 404 } }) : RecordedResponse.Json(200, { payload: { data: Buffer.from(value).toString('base64') } })
        })
        E.Route('POST', /^\/v1\/projects\/pragmatic-ops\/secrets\?secretId=/, request =>
        {
            const id = new URL(request.Path, 'http://x').searchParams.get('secretId')!
            if (this.Secrets.has(id)) return RecordedResponse.Json(409, { error: { code: 409 } })
            this.Secrets.set(id, [])
            return RecordedResponse.Json(200, { name: id })
        })
        E.Route('POST', /^\/v1\/projects\/pragmatic-ops\/secrets\/[^/]+:addVersion$/, request =>
        {
            const id = /secrets\/([^/:]+):addVersion$/.exec(request.Path)![1]!
            this.Secrets.get(id)!.push(Buffer.from((request.Json as { payload: { data: string } }).payload.data, 'base64').toString())
            return RecordedResponse.Json(200, {})
        })
        E.Route('DELETE', /^\/v1\/projects\/pragmatic-ops\/secrets\/[^/]+$/, request =>
        {
            const id = /secrets\/([^/]+)$/.exec(request.Path)![1]!
            return this.Secrets.delete(id) ? RecordedResponse.Json(200, {}) : RecordedResponse.Json(404, { error: { code: 404 } })
        })
        await E.Start()
        await this.Metadata.Start()
        return this
    }

    public get Google(): GcpEndpoints
    {
        return new GcpEndpoints(this.Endpoints.Origin, this.Endpoints.Origin, this.Endpoints.Origin)
    }

    public async Stop(): Promise<void>
    {
        await this.Endpoints.Stop()
        await this.Metadata.Stop()
    }
}

class Scene
{
    public static async With(body: (fake: GoogleFake, tokenFile: string, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'gcp-wi-'))
        const fake = await new GoogleFake().Start()
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

    public static Open(fake: GoogleFake, tokenFile: string, values: Record<string, string> = {}): Promise<ISecretStore>
    {
        const home = new RealmSecretsHome([new GcpWorkloadIdentity(fake.Google)])
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Gcp, { projectId: 'pragmatic-ops', workloadIdentityAudience: Audience, ...values })
        return home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-idp', tokenFile))
    }

    public static Failure(code: SecretsHomeFailure): (error: unknown) => boolean
    {
        return error =>
        {
            assert.ok(error instanceof SecretsHomeUnavailableError, String(error))
            assert.equal(error.Option, RealmSecretsOption.Gcp)
            assert.equal(error.Code, code)
            assert.doesNotMatch(error.message, /audience in the token|secret-looking|Permission denied on resource/)
            return true
        }
    }
}

test('gcp: exchanges the projected token and reads a secret', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile, { serviceAccountEmail: Email })
        fake.Secrets.set(GcpRealmSecretStore.SecretIdFor('acme', 'probe'), ['first', 'second'])
        assert.equal(await store.Get('probe'), 'second')
        assert.equal(await store.Get('probe@1'), 'first')
        const exchange = fake.Endpoints.To(/^\/v1\/token$/)[0]!
        assert.equal(exchange.Form.get('subject_token'), ProjectToken, 'the projected token is what was presented')
        assert.equal(exchange.Form.get('audience'), Audience)
        assert.equal(exchange.Form.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt')
        assert.equal(fake.Endpoints.To(/generateAccessToken$/)[0]!.Path, `/v1/projects/-/serviceAccounts/${Email}:generateAccessToken`)
        const read = fake.Endpoints.To(/:access$/)[0]!
        assert.equal(read.Headers.authorization, 'Bearer impersonated-token')
        assert.match(read.Path, /\/secrets\/acme_probe\/versions\/latest:access$/, 'secret ids carry the realm prefix')
    })
})

test('gcp: without a service account the federated token itself reads; writes add versions', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        await store.Put('probe', 'one')
        await store.Put('probe', 'two')
        assert.equal(await store.Get('probe'), 'two')
        assert.equal(fake.Endpoints.To(/generateAccessToken/).length, 0)
        assert.equal(fake.Endpoints.To(/:access$/)[0]!.Headers.authorization, 'Bearer federated-token')
        await store.Delete('probe')
        await store.Delete('probe')
        assert.equal(await store.Get('probe'), null)
    })
})

test('gcp: a refused exchange is exchange-refused without cloud text', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.RefuseExchange = true
        const store = await Scene.Open(fake, tokenFile)
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.ExchangeRefused))
    })
})

test('gcp: a missing secret is not-found (reads absent); a denied one is permission-denied', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        assert.equal(await store.Get('absent'), null)
        assert.equal(await store.Get('absent@7'), null)
        assert.equal(await store.Get('Not/A/Name'), null)
        fake.DenySecrets = true
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.PermissionDenied))
    })
})

test('gcp: no ambient fallback: with ADC variables and a metadata server present, a missing token is token-unreadable', async () =>
{
    await Scene.With(async (fake, tokenFile, dir) =>
    {
        const adc = join(dir, 'adc.json')
        await writeFile(adc, JSON.stringify({ type: 'authorized_user', client_id: 'x', client_secret: 'y', refresh_token: 'z' }))
        const saved = { ...process.env }
        const metadataHost = fake.Metadata.Origin.replace('http://', '')
        process.env.GOOGLE_APPLICATION_CREDENTIALS = adc
        process.env.GCE_METADATA_HOST = metadataHost
        process.env.GCE_METADATA_IP = metadataHost
        try
        {
            const store = await Scene.Open(fake, join(dir, 'no-token'))
            await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            await assert.rejects(store.Put('probe', 'v'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            assert.equal(fake.Metadata.Requests.length, 0, 'the metadata server is never called')
            assert.equal(fake.Endpoints.Requests.length, 0, 'nothing is sent without the projected token')
        }
        finally
        {
            process.env = saved
        }
    })
})

test('gcp: a key-shaped setting is refused by the descriptor', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        await assert.rejects(Scene.Open(fake, tokenFile, { credentialsJson: '{"type":"service_account","private_key":"x"}' }), (error: Error) => error instanceof RealmSecretsSettingsError && /CREDENTIALS_JSON is refused/.test(error.message))
        await assert.rejects(Scene.Open(fake, tokenFile, { serviceAccountKey: 'x' }), /SERVICE_ACCOUNT_KEY is refused/)
        await assert.rejects(Scene.Open(fake, tokenFile, { workloadIdentityAudience: 'https://example.com' }), /WORKLOAD_IDENTITY_AUDIENCE does not have the form/)
    })
})

test('gcp: an unreachable token exchange is unreachable, an unreachable Secret Manager too', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const context = new WorkloadContext('acme', 'pragmatic-tenant-idp', tokenFile)
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Gcp, { projectId: 'pragmatic-ops', workloadIdentityAudience: Audience })
        const closed = 'http://127.0.0.1:1'
        const noSts = await new RealmSecretsHome([new GcpWorkloadIdentity(new GcpEndpoints(closed, closed, fake.Endpoints.Origin))]).For(settings, context)
        await assert.rejects(noSts.Get('probe'), Scene.Failure(SecretsHomeFailure.Unreachable))
        const noSecrets = await new RealmSecretsHome([new GcpWorkloadIdentity(new GcpEndpoints(fake.Endpoints.Origin, fake.Endpoints.Origin, closed))]).For(settings, context)
        await assert.rejects(noSecrets.Get('probe'), Scene.Failure(SecretsHomeFailure.Unreachable))
    })
})
