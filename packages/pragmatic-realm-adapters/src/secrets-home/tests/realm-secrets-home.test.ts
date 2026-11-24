import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { CloudSecretManagerSecretStore } from '../../secrets/cloud-secret-manager-secret-store.js'
import { type IRealmSecretStore, type IRealmSecretsHomeFactory, RealmSecretsHome } from '../realm-secrets-home.js'
import { RealmSecretName } from '../realm-secret-name.js'
import { RealmSecretsOption } from '../realm-secrets-option.js'
import { RealmSecretsSettingRule, RealmSecretsSettings, RealmSecretsSettingsError } from '../realm-secrets-settings.js'
import { SecretsHomeFailure, SecretsHomeUnavailableError } from '../secrets-home-unavailable-error.js'
import { WorkloadContext, WorkloadContextError } from '../workload-context.js'

class RecordingFactory implements IRealmSecretsHomeFactory
{
    public readonly Opened: { Settings: RealmSecretsSettings, Context: WorkloadContext }[] = []
    public readonly Settings = [
        new RealmSecretsSettingRule('projectId', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, true, 'a project id'),
        new RealmSecretsSettingRule('serviceAccountEmail', /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/, false, 'a service account email'),
    ]

    public constructor(public readonly Option: RealmSecretsOption, private readonly store: ISecretStore = new CloudSecretManagerSecretStore())
    {
    }

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<IRealmSecretStore>
    {
        this.Opened.push({ Settings: settings, Context: context })
        return Promise.resolve(Object.assign(this.store, { Verify: () => Promise.resolve() }))
    }
}

class HomeCase
{
    public static readonly Context = new WorkloadContext('acme', 'pragmatic-tenant-idp', '/nonexistent/token')
}

test('an unknown option is refused naming the option', async () =>
{
    const home = new RealmSecretsHome([new RecordingFactory(RealmSecretsOption.Gcp)])
    await assert.rejects(home.For(RealmSecretsSettings.Of(RealmSecretsOption.Aws, {}), HomeCase.Context), (error: Error) =>
    {
        assert.ok(error instanceof RealmSecretsSettingsError)
        assert.match(error.message, /aws/)
        return true
    })
    assert.throws(() => RealmSecretsSettings.FromEnvironment({ PRAGMATIC_REALM_SECRETS_OPTION: 'vault' }), /custom, gcp, azure, aws/)
})

test('the home opens the option\'s factory with validated settings and the workload', async () =>
{
    const gcp = new RecordingFactory(RealmSecretsOption.Gcp)
    const home = new RealmSecretsHome([gcp, new RecordingFactory(RealmSecretsOption.Custom)])
    const settings = RealmSecretsSettings.FromEnvironment({ PRAGMATIC_REALM_SECRETS_OPTION: 'gcp', PRAGMATIC_REALM_SECRETS_PROJECT_ID: 'pragmatic-ops', OTHER: 'x' })!
    await home.For(settings, HomeCase.Context)
    assert.equal(gcp.Opened.length, 1)
    assert.equal(gcp.Opened[0]!.Settings.Get('projectId'), 'pragmatic-ops')
    assert.equal(gcp.Opened[0]!.Context.RealmId, 'acme')
    assert.deepEqual([...home.Options].sort(), ['custom', 'gcp'])
    assert.throws(() => new RealmSecretsHome([gcp, gcp]), /two realm secrets home factories/)
})

test('no option in the environment means no realm secrets home', () =>
{
    assert.equal(RealmSecretsSettings.FromEnvironment({}), undefined)
    assert.equal(RealmSecretsSettings.FromEnvironment({ PRAGMATIC_REALM_SECRETS_OPTION: '' }), undefined)
})

test('settings are refused by name, never by value: unknown, key-shaped, malformed, missing', () =>
{
    const rules = new RecordingFactory(RealmSecretsOption.Gcp).Settings
    const refuse = (values: Record<string, string>, pattern: RegExp): void =>
    {
        assert.throws(() => RealmSecretsSettings.Of(RealmSecretsOption.Gcp, values).Validated(rules), (error: Error) =>
        {
            assert.ok(error instanceof RealmSecretsSettingsError)
            assert.match(error.message, pattern)
            for (const value of Object.values(values)) assert.ok(!error.message.includes(value), 'the message never carries a value')
            return true
        })
    }
    refuse({ projectId: 'pragmatic-ops', region: 'zz-north-9' }, /PRAGMATIC_REALM_SECRETS_REGION is not a setting of the realm secrets option gcp/)
    refuse({ projectId: 'pragmatic-ops', credentialsJson: '{"type":"service_account"}' }, /CREDENTIALS_JSON is refused: a realm secrets home takes identifiers only/)
    refuse({ projectId: 'pragmatic-ops', clientSecret: 'abc' }, /CLIENT_SECRET is refused/)
    refuse({ projectId: 'pragmatic-ops', accessKeyId: 'AKIAABCDEFGHIJKLMNOP' }, /ACCESS_KEY_ID is refused/)
    refuse({ projectId: '-----BEGIN PRIVATE KEY-----' }, /PROJECT_ID holds a key-shaped value/)
    refuse({ projectId: 'Not A Project' }, /PROJECT_ID does not have the form of a project id/)
    refuse({}, /PROJECT_ID is required by the realm secrets option gcp/)
})

test('setting names map to the chart\'s variables both ways', () =>
{
    assert.equal(RealmSecretsSettings.VariableOf('workloadIdentityAudience'), 'PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE')
    const settings = RealmSecretsSettings.FromEnvironment({ PRAGMATIC_REALM_SECRETS_OPTION: 'azure', PRAGMATIC_REALM_SECRETS_VAULT_URL: 'https://v.vault.azure.net/' })!
    assert.equal(settings.Option, RealmSecretsOption.Azure)
    assert.deepEqual(settings.Names, ['vaultUrl'])
})

test('a realm secret name is one lowercase segment, optionally pinned', () =>
{
    assert.deepEqual({ ...RealmSecretName.TryParse('google-client-secret') }, { Name: 'google-client-secret', Version: undefined })
    assert.deepEqual({ ...RealmSecretName.TryParse('probe@3') }, { Name: 'probe', Version: '3' })
    for (const key of ['Upper', 'a/b', '.key-check', '-lead', 'x@', 'x@-1', 'a'.repeat(64)]) assert.equal(RealmSecretName.TryParse(key), undefined, key)
    assert.throws(() => RealmSecretName.ForWrite('a/b'), /one segment/)
})

test('the workload context comes from the chart\'s environment and reads the token on every call', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'workload-'))
    try
    {
        const token = join(dir, 'token')
        const read = WorkloadContext.FromEnvironment({ PRAGMATIC_REALM_ID: 'acme', PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin', PRAGMATIC_WORKLOAD_TOKEN_FILE: token })
        assert.equal(read.Component, 'pragmatic-tenant-admin')
        await assert.rejects(read.ReadToken(RealmSecretsOption.Gcp), (error: Error) => error instanceof SecretsHomeUnavailableError && error.Code === SecretsHomeFailure.TokenUnreadable && error.Option === RealmSecretsOption.Gcp)
        await writeFile(token, '   \n')
        await assert.rejects(read.ReadToken(RealmSecretsOption.Gcp), /token-unreadable/)
        await writeFile(token, 'first.jwt\n')
        assert.equal(await read.ReadToken(RealmSecretsOption.Gcp), 'first.jwt')
        await writeFile(token, 'rotated.jwt')
        assert.equal(await read.ReadToken(RealmSecretsOption.Gcp), 'rotated.jwt')
        assert.equal(WorkloadContext.FromEnvironment({ PRAGMATIC_REALM_ID: 'acme' }, 'pragmatic-env-server').TokenPath, WorkloadContext.DefaultTokenPath)
        assert.equal(read.ForRealm('staff').RealmId, 'staff')
        assert.throws(() => WorkloadContext.FromEnvironment({}), (error: Error) => error instanceof WorkloadContextError && /PRAGMATIC_REALM_ID/.test(error.message))
        assert.throws(() => new WorkloadContext('Acme', 'x'), /realm id/)
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
