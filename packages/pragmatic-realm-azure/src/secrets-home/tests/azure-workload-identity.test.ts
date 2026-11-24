import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpClient, HttpHeaders, PipelineRequest, PipelineResponse } from '@azure/core-rest-pipeline'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmSecretsHome, RealmSecretsOption, RealmSecretsSettings, RealmSecretsSettingsError, SecretsHomeFailure, SecretsHomeUnavailableError, WorkloadContext } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { AzureRealmSecretStore, AzureTransport, AzureWorkloadIdentity } from '../azure-workload-identity.js'

const Tenant = '11111111-2222-3333-4444-555555555555'
const Client = '66666666-7777-8888-9999-000000000000'
const Vault = 'https://acme-realm.vault.azure.net'
const ProjectToken = 'projected.service-account.jwt'

class FakeHeaders implements HttpHeaders
{
    private readonly values = new Map<string, string>()

    public constructor(initial: Record<string, string> = {})
    {
        for (const [name, value] of Object.entries(initial)) this.set(name, value)
    }

    public get(name: string): string | undefined
    {
        return this.values.get(name.toLowerCase())
    }

    public has(name: string): boolean
    {
        return this.values.has(name.toLowerCase())
    }

    public set(name: string, value: string | number | boolean): void
    {
        this.values.set(name.toLowerCase(), String(value))
    }

    public delete(name: string): void
    {
        this.values.delete(name.toLowerCase())
    }

    public toJSON(): Record<string, string>
    {
        return Object.fromEntries(this.values)
    }

    public [Symbol.iterator](): Iterator<[string, string]>
    {
        return this.values.entries()
    }
}

/** A recorded fake of Entra's token endpoint and a Key Vault, as an Azure SDK HTTP client (the SDK's own transport seam). */
class AzureFake implements HttpClient
{
    public readonly Requests: { Method: string, Url: URL, Authorization: string | undefined, Body: string }[] = []
    public readonly Secrets = new Map<string, string[]>()
    public readonly Deleted = new Map<string, string[]>()
    public RefuseExchange = false
    public DenySecrets = false
    public PurgeForbidden = false
    public LoginUnreachable = false

    public async sendRequest(request: PipelineRequest): Promise<PipelineResponse>
    {
        const url = new URL(request.url)
        const body = typeof request.body === 'string' ? request.body : ''
        const authorization = request.headers.get('authorization')
        this.Requests.push({ Method: request.method, Url: url, Authorization: authorization, Body: body })
        const answer = (status: number, json: unknown, headers: Record<string, string> = {}): PipelineResponse =>
            ({ request, status, headers: new FakeHeaders({ 'content-type': 'application/json', ...headers }), bodyAsText: JSON.stringify(json) })
        if (url.host === 'login.microsoftonline.com')
        {
            if (this.LoginUnreachable) throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'RestError', code: 'ECONNREFUSED' })
            if (url.pathname.endsWith('/oauth2/v2.0/token'))
            {
                return this.RefuseExchange
                    ? answer(400, { error: 'invalid_client', error_description: 'AADSTS700213: No matching federated identity record found for presented assertion subject secret-looking detail' })
                    : answer(200, { token_type: 'Bearer', expires_in: 3600, ext_expires_in: 3600, access_token: 'kv-token' })
            }
            if (url.pathname.endsWith('/.well-known/openid-configuration'))
            {
                const base = `https://login.microsoftonline.com/${Tenant}`
                return answer(200, { token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, end_session_endpoint: `${base}/oauth2/v2.0/logout`, issuer: `https://login.microsoftonline.com/${Tenant}/v2.0`, jwks_uri: `${base}/discovery/v2.0/keys` })
            }
            return answer(200, { tenant_discovery_endpoint: `https://login.microsoftonline.com/${Tenant}/v2.0/.well-known/openid-configuration`, metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net'] }] })
        }
        if (authorization !== 'Bearer kv-token')
        {
            return answer(401, { error: { code: 'Unauthorized' } }, { 'www-authenticate': `Bearer authorization="https://login.microsoftonline.com/${Tenant}", resource="https://vault.azure.net"` })
        }
        if (this.DenySecrets) return answer(403, { error: { code: 'Forbidden', message: 'Caller is not authorized: secret-looking detail' } })
        const parts = url.pathname.split('/').filter(part => part !== '')
        const secretJson = (name: string, versions: string[]): unknown => ({ value: versions[versions.length - 1], id: `${Vault}/secrets/${name}/v${versions.length}`, attributes: { enabled: true } })
        if (parts[0] === 'secrets' && request.method === 'GET')
        {
            const versions = this.Secrets.get(parts[1]!)
            if (versions === undefined) return answer(404, { error: { code: 'SecretNotFound' } })
            if (parts[2] !== undefined && parts[2] !== '')
            {
                const index = Number(parts[2].replace(/^v/, '')) - 1
                return versions[index] === undefined ? answer(404, { error: { code: 'SecretNotFound' } }) : answer(200, secretJson(parts[1]!, versions.slice(0, index + 1)))
            }
            return answer(200, secretJson(parts[1]!, versions))
        }
        if (parts[0] === 'secrets' && request.method === 'PUT')
        {
            if (this.Deleted.has(parts[1]!)) return answer(409, { error: { code: 'Conflict', message: 'Secret is currently in a deleted but recoverable state' } })
            const versions = this.Secrets.get(parts[1]!) ?? []
            versions.push((JSON.parse(body) as { value: string }).value)
            this.Secrets.set(parts[1]!, versions)
            return answer(200, secretJson(parts[1]!, versions))
        }
        if (parts[0] === 'secrets' && request.method === 'DELETE')
        {
            const versions = this.Secrets.get(parts[1]!)
            if (versions === undefined) return answer(404, { error: { code: 'SecretNotFound' } })
            this.Secrets.delete(parts[1]!)
            this.Deleted.set(parts[1]!, versions)
            return answer(200, { recoveryId: `${Vault}/deletedsecrets/${parts[1]}`, id: `${Vault}/secrets/${parts[1]}/v1`, attributes: { enabled: true } })
        }
        if (parts[0] === 'deletedsecrets' && parts[2] === 'recover' && request.method === 'POST')
        {
            const versions = this.Deleted.get(parts[1]!)!
            this.Deleted.delete(parts[1]!)
            this.Secrets.set(parts[1]!, versions)
            return answer(200, secretJson(parts[1]!, versions))
        }
        if (parts[0] === 'deletedsecrets' && request.method === 'DELETE')
        {
            if (this.PurgeForbidden) return answer(403, { error: { code: 'Forbidden', message: 'purge not allowed' } })
            this.Deleted.delete(parts[1]!)
            return answer(204, {})
        }
        if (parts[0] === 'deletedsecrets' && request.method === 'GET')
        {
            return this.Deleted.has(parts[1]!) ? answer(200, { recoveryId: `${Vault}/deletedsecrets/${parts[1]}`, id: `${Vault}/secrets/${parts[1]}/v1` }) : answer(404, { error: { code: 'SecretNotFound' } })
        }
        return answer(400, { error: { code: 'BadRequest' } })
    }

    public Exchanges(): { Method: string, Url: URL, Body: string }[]
    {
        return this.Requests.filter(request => request.Url.pathname.endsWith('/oauth2/v2.0/token'))
    }
}

class Scene
{
    public static async With(body: (fake: AzureFake, tokenFile: string, dir: string) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), 'azure-wi-'))
        try
        {
            const tokenFile = join(dir, 'token')
            await writeFile(tokenFile, ProjectToken + '\n')
            await body(new AzureFake(), tokenFile, dir)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static Open(fake: AzureFake, tokenFile: string, values: Record<string, string> = {}): Promise<ISecretStore>
    {
        const home = new RealmSecretsHome([new AzureWorkloadIdentity(new AzureTransport(fake))])
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Azure, { tenantId: Tenant, clientId: Client, vaultUrl: Vault, ...values })
        return home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-admin', tokenFile))
    }

    public static Failure(code: SecretsHomeFailure): (error: unknown) => boolean
    {
        return error =>
        {
            assert.ok(error instanceof SecretsHomeUnavailableError, String(error))
            assert.equal(error.Option, RealmSecretsOption.Azure)
            assert.equal(error.Code, code)
            assert.doesNotMatch(error.message, /AADSTS|secret-looking|not authorized/)
            return true
        }
    }
}

test('azure: exchanges the projected token and reads a secret', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        fake.Secrets.set(AzureRealmSecretStore.SecretNameFor('acme', 'probe'), ['first', 'second'])
        assert.equal(await store.Get('probe'), 'second')
        assert.equal(await store.Get('probe@v1'), 'first')
        const exchange = fake.Exchanges()[0]!
        assert.equal(exchange.Url.pathname, `/${Tenant}/oauth2/v2.0/token`)
        const form = new URLSearchParams(exchange.Body)
        assert.equal(form.get('client_assertion'), ProjectToken, 'the projected token is what was presented')
        assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        assert.equal(form.get('client_id'), Client)
        assert.equal(form.get('scope'), 'https://vault.azure.net/.default')
        const read = fake.Requests.find(request => request.Authorization === 'Bearer kv-token')!
        assert.equal(read.Url.pathname.replace(/\/$/, ''), '/secrets/acme--probe', 'secret names carry the realm prefix')
    })
})

test('azure: a deletion is purged where the identity may purge', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        await store.Put('probe', 'one')
        await store.Delete('probe')
        assert.equal(fake.Deleted.size, 0, 'purged')
        assert.ok(fake.Requests.some(request => request.Method === 'DELETE' && request.Url.pathname.startsWith('/deletedsecrets/')))
        await store.Put('probe', 'two')
        assert.equal(await store.Get('probe'), 'two')
    })
})

test('azure: writes add versions; a deleted name the identity may not purge is recovered before it is written again', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.PurgeForbidden = true
        const store = await Scene.Open(fake, tokenFile)
        await store.Put('probe', 'one')
        await store.Put('probe', 'two')
        assert.equal(await store.Get('probe'), 'two')
        await store.Delete('probe')
        assert.equal(await store.Get('probe'), null)
        await store.Delete('probe')
        await store.Put('probe', 'three')
        assert.equal(await store.Get('probe'), 'three')
    })
})

test('azure: a refused exchange is exchange-refused without cloud text', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.RefuseExchange = true
        const store = await Scene.Open(fake, tokenFile)
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.ExchangeRefused))
    })
})

test('azure: an unreachable login host is unreachable, not a refused exchange', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        fake.LoginUnreachable = true
        const store = await Scene.Open(fake, tokenFile)
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.Unreachable))
    })
})

test('azure: with AZURE_* variables present, the projected token is what is presented', async () =>
{
    await Scene.With(async (fake, tokenFile, dir) =>
    {
        const ambientToken = join(dir, 'ambient-token')
        await writeFile(ambientToken, 'ambient.jwt')
        const saved = { ...process.env }
        Object.assign(process.env, { AZURE_FEDERATED_TOKEN_FILE: ambientToken, AZURE_TENANT_ID: '99999999-9999-9999-9999-999999999999', AZURE_CLIENT_ID: '88888888-8888-8888-8888-888888888888', AZURE_CLIENT_SECRET: 'ambient-secret', AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.us' })
        try
        {
            const store = await Scene.Open(fake, tokenFile)
            fake.Secrets.set(AzureRealmSecretStore.SecretNameFor('acme', 'probe'), ['value'])
            assert.equal(await store.Get('probe'), 'value')
            const exchange = fake.Exchanges()[0]!
            assert.equal(exchange.Url.host, 'login.microsoftonline.com')
            assert.equal(exchange.Url.pathname, `/${Tenant}/oauth2/v2.0/token`)
            const form = new URLSearchParams(exchange.Body)
            assert.equal(form.get('client_assertion'), ProjectToken)
            assert.equal(form.get('client_id'), Client)
            assert.equal(form.get('client_secret'), null)
        }
        finally
        {
            process.env = saved
        }
    })
})

test('azure: a realm id that does not fit Key Vault names is refused at open; Verify reads the token only', async () =>
{
    await Scene.With(async (fake, tokenFile, dir) =>
    {
        const home = new RealmSecretsHome([new AzureWorkloadIdentity(new AzureTransport(fake))])
        const settings = RealmSecretsSettings.Of(RealmSecretsOption.Azure, { tenantId: Tenant, clientId: Client, vaultUrl: Vault })
        await assert.rejects(home.For(settings, new WorkloadContext('a--b', 'pragmatic-tenant-idp', tokenFile)), RealmSecretsSettingsError)
        await assert.rejects(home.For(settings, new WorkloadContext('r'.repeat(63), 'pragmatic-tenant-idp', tokenFile)), /does not fit Key Vault/)
        assert.ok(AzureRealmSecretStore.FitsRealm('r'.repeat(62)))
        await (await home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-idp', tokenFile))).Verify()
        await assert.rejects((await home.For(settings, new WorkloadContext('acme', 'pragmatic-tenant-idp', join(dir, 'none')))).Verify(), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
        assert.equal(fake.Requests.length, 0)
    })
})

test('azure: a missing secret is not-found (reads absent); a denied one is permission-denied', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        const store = await Scene.Open(fake, tokenFile)
        assert.equal(await store.Get('absent'), null)
        assert.equal(await store.Get('absent@v3'), null)
        fake.DenySecrets = true
        await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.PermissionDenied))
    })
})

test('azure: no ambient fallback: with AZURE_* variables present, a missing token is token-unreadable and nothing is sent', async () =>
{
    await Scene.With(async (fake, _tokenFile, dir) =>
    {
        const ambientToken = join(dir, 'ambient-token')
        await writeFile(ambientToken, 'ambient.jwt')
        const saved = { ...process.env }
        Object.assign(process.env, { AZURE_FEDERATED_TOKEN_FILE: ambientToken, AZURE_TENANT_ID: Tenant, AZURE_CLIENT_ID: Client, AZURE_CLIENT_SECRET: 'ambient-secret', AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.us', IDENTITY_ENDPOINT: 'http://127.0.0.1:1/metadata', MSI_ENDPOINT: 'http://127.0.0.1:1/msi' })
        try
        {
            const store = await Scene.Open(fake, join(dir, 'no-token'))
            await assert.rejects(store.Get('probe'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            await assert.rejects(store.Put('probe', 'v'), Scene.Failure(SecretsHomeFailure.TokenUnreadable))
            assert.equal(fake.Requests.length, 0, 'nothing is sent without the projected token')
        }
        finally
        {
            process.env = saved
        }
    })
})

test('azure: a key-shaped setting is refused by the descriptor', async () =>
{
    await Scene.With(async (fake, tokenFile) =>
    {
        await assert.rejects(Scene.Open(fake, tokenFile, { clientSecret: 'abc' }), (error: Error) => error instanceof RealmSecretsSettingsError && /CLIENT_SECRET is refused/.test(error.message))
        await assert.rejects(Scene.Open(fake, tokenFile, { clientCertificate: 'x' }), /CLIENT_CERTIFICATE is refused/)
        await assert.rejects(Scene.Open(fake, tokenFile, { vaultUrl: 'https://evil.example.com' }), /VAULT_URL does not have the form/)
        for (const vault of ['https://1vault.vault.azure.net', 'https://' + 'v'.repeat(30) + '.vault.azure.net', 'https://ab--cd.vault.azure.net', 'https://vault-.vault.azure.net', 'https://acme.vault.microsoftazure.de'])
        {
            await assert.rejects(Scene.Open(fake, tokenFile, { vaultUrl: vault }), /VAULT_URL does not have the form/, vault)
        }
        await Scene.Open(fake, tokenFile, { vaultUrl: 'https://' + 'v'.repeat(24) + '.vault.azure.net/' })
    })
})
