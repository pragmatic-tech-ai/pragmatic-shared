import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { EnvironmentRealmSecrets, EnvironmentRealmSecretsError, type EnvironmentRealmSecretsMaterial, type IEnvironmentRealmSecretsMaterial } from '../environment-realm-secrets.js'
import { EnvironmentWorkloadFactory, type EngineEnvironment } from '../environment-workload.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { InClusterEnvironmentRuntime, InClusterOperationFailedError } from '../in-cluster-environment-runtime.js'
import type { IEnvironmentDatabaseProvisioner } from '../environment-database-provisioner.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import type { IBundleBuilder } from '../environment-seed-port.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'

class RealmFixture
{
    public static readonly Audience = '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pragmatic-hives/providers/pragmatic-customer'

    public static Gcp(): Record<string, string>
    {
        return {
            PRAGMATIC_REALM_SECRETS_OPTION: 'gcp',
            PRAGMATIC_REALM_SECRETS_PROJECT_ID: 'pragmatic-ops',
            PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE: RealmFixture.Audience,
            PRAGMATIC_REALM_ID: 'acme',
            PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin',
            PRAGMATIC_WORKLOAD_TOKEN_FILE: '/var/run/secrets/pragmatic/workload-identity/token',
        }
    }

    public static Custom(): Record<string, string>
    {
        return {
            PRAGMATIC_REALM_SECRETS_OPTION: 'custom',
            PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE: '/run/secrets/realm-secrets-console/database-url',
            PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE: '/run/secrets/pragmatic-realm-master-key/master.key',
            PRAGMATIC_REALM_SECRETS_ACCESS: 'writer',
            PRAGMATIC_REALM_ID: 'acme',
            PRAGMATIC_COMPONENT: 'pragmatic-tenant-admin',
        }
    }

    public static Hive(): HiveRecord
    {
        return {
            id: 'hive-1', tenantId: 'acme', displayName: 'h',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, createdAt: '2026-11-24T00:00:00Z',
        }
    }

    public static Env(): EnvironmentRecord
    {
        return {
            name: 'sales-eu', type: EnvType.Runtime, template: Template.RuntimePostgres, environmentId: 'acme', hiveId: 'hive-1', hostPort: 8081,
            containerName: 'c', volumeName: 'v', bundleDir: 'b', createdAt: '2026-11-24T00:00:00Z', status: EnvStatus.Running,
        }
    }

    public static Engine(realm?: EnvironmentRealmSecrets): EngineEnvironment
    {
        return {
            ServerImage: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@sha256:' + 'a'.repeat(64),
            UiUnpackImage: 'ghcr.io/pragmatic-tech-ai/pragmatic-ui-unpack@sha256:' + 'b'.repeat(64),
            RealmSecrets: realm,
        }
    }

    public static Server(realm?: EnvironmentRealmSecrets): { container: any; volumes: any[] }
    {
        const workload = EnvironmentWorkloadFactory.From(RealmFixture.Env(), RealmFixture.Hive(), undefined, undefined, RealmFixture.Engine(realm))
        const deployment = (JSON.parse(new K8sManifestBuilder().Render(workload)).items as any[]).find(i => i.kind === 'Deployment')
        return { container: deployment.spec.template.spec.containers[0], volumes: deployment.spec.template.spec.volumes }
    }

    public static EnvOf(container: any): Record<string, string>
    {
        return Object.fromEntries((container.env as any[]).map(e => [e.name, e.value]))
    }
}

class CountingMaterial implements IEnvironmentRealmSecretsMaterial
{
    public Reads = 0

    public async Read(): Promise<EnvironmentRealmSecretsMaterial>
    {
        this.Reads++
        return { DatabaseUrl: Buffer.from('postgres://realm_secrets_environments:pw@pragmatic-postgres.pragmatic-system.svc:5432/realm_secrets'), MasterKey: Buffer.alloc(32, 7) }
    }
}

/** Secrets in memory by `<namespace> secret/<name>`. */
class SecretKubectl
{
    public readonly Secrets = new Map<string, Record<string, string>>()

    public async Create(manifestJson: string): Promise<boolean>
    {
        const item = JSON.parse(manifestJson)
        const key = item.metadata.namespace + ' secret/' + item.metadata.name
        if (this.Secrets.has(key)) return false
        this.Secrets.set(key, item.data)
        return true
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        const data = this.Secrets.get(namespace + ' ' + resource)
        return data === undefined ? undefined : JSON.stringify({ kind: 'Secret', data })
    }
}

describe('EnvironmentRealmSecrets', () =>
{
    it('is undefined without a realm secrets option (today\'s hives)', () =>
    {
        assert.equal(EnvironmentRealmSecrets.FromEnvironment({ PRAGMATIC_REALM_ID: 'acme' }), undefined)
        const { container, volumes } = RealmFixture.Server(undefined)
        assert.equal(Object.keys(RealmFixture.EnvOf(container)).some(name => name.startsWith('PRAGMATIC_REALM')), false)
        assert.equal(volumes.some(v => v.name.startsWith('realm-')), false)
    })

    it('gcp renders the projected token with the pool audience, the identifiers, the realm and the env server as component', () =>
    {
        const realm = EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Gcp())!
        const { container, volumes } = RealmFixture.Server(realm)
        const env = RealmFixture.EnvOf(container)
        assert.equal(env.PRAGMATIC_REALM_SECRETS_OPTION, 'gcp')
        assert.equal(env.PRAGMATIC_REALM_SECRETS_PROJECT_ID, 'pragmatic-ops')
        assert.equal(env.PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE, RealmFixture.Audience)
        assert.equal(env.PRAGMATIC_REALM_ID, 'acme')
        assert.equal(env.PRAGMATIC_COMPONENT, 'pragmatic-env-server', 'the environment server\'s own identity, not the console\'s')
        assert.equal(env.PRAGMATIC_WORKLOAD_TOKEN_FILE, '/var/run/secrets/pragmatic/workload-identity/token')
        const token = volumes.find(v => v.name === 'realm-workload-identity')
        assert.deepEqual(token.projected.sources, [{ serviceAccountToken: { audience: RealmFixture.Audience, expirationSeconds: 3600, path: 'token' } }])
        assert.ok((container.volumeMounts as any[]).some(m => m.name === 'realm-workload-identity' && m.mountPath === '/var/run/secrets/pragmatic/workload-identity' && m.readOnly === true))
        assert.equal(volumes.some(v => v.name === 'realm-master-key'), false, 'no master key for a cloud option')
    })

    it('azure and aws project their fixed audiences', () =>
    {
        const azure = EnvironmentRealmSecrets.FromEnvironment({
            PRAGMATIC_REALM_SECRETS_OPTION: 'azure', PRAGMATIC_REALM_SECRETS_TENANT_ID: '00000000-0000-0000-0000-000000000001',
            PRAGMATIC_REALM_SECRETS_CLIENT_ID: '00000000-0000-0000-0000-000000000002', PRAGMATIC_REALM_SECRETS_VAULT_URL: 'https://acme.vault.azure.net', PRAGMATIC_REALM_ID: 'acme',
        })!
        assert.equal(azure.Audience, 'api://AzureADTokenExchange')
        assert.equal(RealmFixture.EnvOf(RealmFixture.Server(azure).container).PRAGMATIC_REALM_SECRETS_CLIENT_ID, '00000000-0000-0000-0000-000000000002')
        const aws = EnvironmentRealmSecrets.FromEnvironment({
            PRAGMATIC_REALM_SECRETS_OPTION: 'aws', PRAGMATIC_REALM_SECRETS_REGION: 'eu-west-1',
            PRAGMATIC_REALM_SECRETS_ROLE_ARN: 'arn:aws:iam::123456789012:role/acme-realm', PRAGMATIC_REALM_ID: 'acme',
        })!
        assert.equal(aws.Audience, 'sts.amazonaws.com')
        const token = RealmFixture.Server(aws).volumes.find(v => v.name === 'realm-workload-identity')
        assert.equal(token.projected.sources[0].serviceAccountToken.audience, 'sts.amazonaws.com')
    })

    it('custom mounts the reader URL and the master key, reads as reader, and carries none of the console\'s paths', () =>
    {
        const realm = EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Custom(), new CountingMaterial())!
        const { container, volumes } = RealmFixture.Server(realm)
        const env = RealmFixture.EnvOf(container)
        assert.equal(env.PRAGMATIC_REALM_SECRETS_OPTION, 'custom')
        assert.equal(env.PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE, '/run/secrets/pragmatic-realm-secrets/database-url')
        assert.equal(env.PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE, '/run/secrets/pragmatic-realm-master-key/master.key')
        assert.equal(env.PRAGMATIC_REALM_SECRETS_ACCESS, 'reader')
        assert.equal(env.PRAGMATIC_WORKLOAD_TOKEN_FILE, undefined, 'no workload identity for the custom home')
        assert.equal(volumes.some(v => v.name === 'realm-workload-identity'), false)
        const reader = volumes.find(v => v.name === 'realm-secrets-reader')
        assert.deepEqual(reader.secret, { secretName: 'pragmatic-realm-secrets-reader', defaultMode: 0o440, items: [{ key: 'database-url', path: 'database-url' }] })
        const key = volumes.find(v => v.name === 'realm-master-key')
        assert.deepEqual(key.secret.items, [{ key: 'master.key', path: 'master.key' }])
    })

    it('refuses what the environments could not read with', () =>
    {
        assert.throws(() => EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Custom()), EnvironmentRealmSecretsError, 'custom without the reader material')
        const gcp = RealmFixture.Gcp()
        delete gcp.PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE
        assert.throws(() => EnvironmentRealmSecrets.FromEnvironment(gcp), /WORKLOAD_IDENTITY_AUDIENCE/)
        const noRealm = RealmFixture.Gcp()
        delete noRealm.PRAGMATIC_REALM_ID
        assert.throws(() => EnvironmentRealmSecrets.FromEnvironment(noRealm), /PRAGMATIC_REALM_ID/)
    })

    it('copies the custom Secrets into the namespace once, keeping existing ones and reading nothing then', async () =>
    {
        const material = new CountingMaterial()
        const realm = EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Custom(), material)!
        const kubectl = new SecretKubectl()
        await realm.EnsureCopies(kubectl as unknown as IKubectl, 'pragmatic-env-sales-eu')
        assert.equal(kubectl.Secrets.size, 2)
        assert.equal(Buffer.from(kubectl.Secrets.get('pragmatic-env-sales-eu secret/pragmatic-realm-master-key')!['master.key'], 'base64').length, 32)
        assert.match(Buffer.from(kubectl.Secrets.get('pragmatic-env-sales-eu secret/pragmatic-realm-secrets-reader')!['database-url'], 'base64').toString(), /realm_secrets_environments/)
        await realm.EnsureCopies(kubectl as unknown as IKubectl, 'pragmatic-env-sales-eu')
        assert.equal(material.Reads, 1, 'nothing read when both copies exist')
        const cloud = EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Gcp())!
        const empty = new SecretKubectl()
        await cloud.EnsureCopies(empty as unknown as IKubectl, 'pragmatic-env-sales-eu')
        assert.equal(empty.Secrets.size, 0, 'a cloud option copies nothing')
    })

    it('a bring-up copies the custom Secrets after the apply', async () =>
    {
        const kubectl = new SecretKubectl()
        const realm = EnvironmentRealmSecrets.FromEnvironment(RealmFixture.Custom(), new CountingMaterial())!
        const orchestrator = { Kubectl: kubectl, Apply: async () => undefined } as unknown as IHiveOrchestrator
        const orchestrators = { For: () => orchestrator } as unknown as HiveOrchestratorFactory
        const workload = EnvironmentWorkloadFactory.From(RealmFixture.Env(), RealmFixture.Hive(), undefined, undefined, RealmFixture.Engine(realm))
        const placement = { WorkloadFor: () => workload } as unknown as EnvironmentPlacement
        const directory = { GetHive: () => RealmFixture.Hive() } as unknown as ITenantDirectory
        const provisioner: IEnvironmentDatabaseProvisioner = { Ensure: async () => undefined, Drop: async () => undefined }
        const runtime = new InClusterEnvironmentRuntime(orchestrators, placement, directory, {} as IBundleBuilder, undefined, provisioner)
        const ctx = { record: { name: 'sales-eu', hiveId: 'hive-1' }, def: { environmentId: 'acme' }, bundleDir: 'b' } as unknown as EnvRuntimeContext
        // The bundle step after the copies fails on the test's empty bundle folder; the copies have happened by then.
        await assert.rejects(runtime.BringUp(ctx), (err: unknown) => err instanceof InClusterOperationFailedError)
        assert.ok(kubectl.Secrets.has('pragmatic-env-sales-eu secret/pragmatic-realm-secrets-reader'))
        assert.ok(kubectl.Secrets.has('pragmatic-env-sales-eu secret/pragmatic-realm-master-key'))
    })
})
