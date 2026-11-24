import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterEnvironmentRuntime, InClusterOperationFailedError } from '../in-cluster-environment-runtime.js'
import { EnvironmentHiveDatabase, EnvironmentWorkloadFactory, WorkloadServerDatabases, type EngineEnvironment, type EnvironmentWorkload } from '../environment-workload.js'
import { EnvironmentHiveDatabaseSecret, HiveDatabaseUnavailableError, type IEnvironmentDatabaseProvisioner } from '../environment-database-provisioner.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import type { IBundleBuilder } from '../environment-seed-port.js'
import type { IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'

class EngineFixture
{
    public static readonly EnvName = 'sales-eu'
    public static readonly Engine: EngineEnvironment = {
        ServerImage: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@sha256:' + 'a'.repeat(64),
        UiUnpackImage: 'ghcr.io/pragmatic-tech-ai/pragmatic-ui-unpack@sha256:' + 'b'.repeat(64),
    }

    public static Hive(): HiveRecord
    {
        return {
            id: 'hive-1', tenantId: 't1', displayName: 'h',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, createdAt: '2026-11-24T00:00:00Z',
        }
    }

    public static Env(): EnvironmentRecord
    {
        return {
            name: EngineFixture.EnvName, type: EnvType.Runtime, template: Template.RuntimePostgres, environmentId: 't1', hiveId: 'hive-1', hostPort: 8081,
            containerName: 'c', volumeName: 'v', bundleDir: 'b', createdAt: '2026-11-24T00:00:00Z', status: EnvStatus.Running,
            appDeployment: { appName: 'crm', appVersion: '1.0.0', repo: 'apps/crm', artifactTag: 'v1', manifestDigest: 'sha256:abc' },
        }
    }

    public static Workload(): EnvironmentWorkload
    {
        return EnvironmentWorkloadFactory.From(EngineFixture.Env(), EngineFixture.Hive(), undefined, undefined, EngineFixture.Engine)
    }
}

/** Records the provisioner calls; optionally fails the first Ensure (Postgres restarted mid-provisioning). */
class RecordingProvisioner implements IEnvironmentDatabaseProvisioner
{
    public readonly Ensured: Array<[string, string]> = []
    public readonly Dropped: string[] = []

    public constructor(private failures: number = 0)
    {
    }

    public async Ensure(environmentName: string, password: string): Promise<void>
    {
        if (this.failures > 0)
        {
            this.failures--
            throw new Error('the connection was terminated')
        }
        this.Ensured.push([environmentName, password])
    }

    public async Drop(environmentName: string): Promise<void>
    {
        this.Dropped.push(environmentName)
    }
}

/** Secrets in memory, by namespace and `secret/<name>`; `racing` makes the first create lose to a rival's Secret. */
class SecretKubectl
{
    public readonly Secrets = new Map<string, Record<string, string>>()
    public Creates = 0

    public constructor(private racing?: Record<string, string>)
    {
    }

    public async Create(manifestJson: string): Promise<boolean>
    {
        const item = JSON.parse(manifestJson)
        const key = item.metadata.namespace + ' secret/' + item.metadata.name
        if (this.racing !== undefined)
        {
            this.Secrets.set(key, this.racing)
            this.racing = undefined
        }
        if (this.Secrets.has(key))
        {
            return false
        }
        this.Creates++
        this.Secrets.set(key, item.data)
        return true
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        const data = this.Secrets.get(namespace + ' ' + resource)
        return data === undefined ? undefined : JSON.stringify({ kind: 'Secret', data })
    }

    public Password(environment: string): string | undefined
    {
        const data = this.Secrets.get(K8sManifestBuilder.NamespaceOf(environment) + ' secret/' + EnvironmentHiveDatabase.SecretNameOf(environment))
        return data === undefined ? undefined : Buffer.from(data.password, 'base64').toString('utf8')
    }

    public Url(environment: string): string | undefined
    {
        const data = this.Secrets.get(K8sManifestBuilder.NamespaceOf(environment) + ' secret/' + EnvironmentHiveDatabase.SecretNameOf(environment))
        return data === undefined ? undefined : Buffer.from(data['database-url'], 'base64').toString('utf8')
    }
}

describe('an engine environment', () =>
{
    it('runs the release images and references its database secret, with no sidecar', () =>
    {
        const w = EngineFixture.Workload()
        assert.equal(w.image, EngineFixture.Engine.ServerImage)
        assert.equal(w.appDeployment?.unpackImage, EngineFixture.Engine.UiUnpackImage)
        assert.deepEqual(w.serverDatabase, { UrlSecretName: 'sales-eu-database' })
        assert.equal(WorkloadServerDatabases.IsSidecar(w.serverDatabase), false)
        assert.deepEqual(EnvironmentWorkloadFactory.ImagesOf(w), [EngineFixture.Engine.ServerImage, EngineFixture.Engine.UiUnpackImage])
    })

    it('an engine environment references its database secret and has no sidecar', () =>
    {
        const items = JSON.parse(new K8sManifestBuilder().Render(EngineFixture.Workload())).items as any[]
        const deployment = items.find(i => i.kind === 'Deployment')
        const containers = deployment.spec.template.spec.containers as any[]
        assert.deepEqual(containers.map(c => c.name), ['server'])
        const volume = (deployment.spec.template.spec.volumes as any[]).find(v => v.name === 'database-url')
        assert.deepEqual(volume.secret.items, [{ key: 'database-url', path: 'database-url' }])
        assert.equal(volume.secret.secretName, 'sales-eu-database')
        const server = containers[0]
        assert.ok((server.env as any[]).some(e => e.name === 'PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE' && e.value === '/run/secrets/pragmatic-env-server/database-url'))
        assert.equal(items.some(i => i.kind === 'ConfigMap' && i.metadata.name === 'sales-eu-postgres'), false, 'no sidecar applications file')
    })

    it('names its database and role env_<name>, refusing a name that makes no identifier', () =>
    {
        assert.equal(EnvironmentHiveDatabase.NameOf('sales-eu'), 'env_sales_eu')
        assert.equal(EnvironmentHiveDatabase.UrlOf('sales-eu', 'p/w'), 'postgres://env_sales_eu:p%2Fw@pragmatic-postgres.pragmatic-system.svc:5432/env_sales_eu')
        assert.throws(() => EnvironmentHiveDatabase.NameOf('x'.repeat(60)), /PostgreSQL identifier/)
        assert.throws(() => EnvironmentHiveDatabase.NameOf('Bad.Name'), /PostgreSQL identifier/)
    })
})

describe('EnvironmentHiveDatabaseSecret', () =>
{
    it('mints the password once, provisions with it and stores it with the URL', async () =>
    {
        const kubectl = new SecretKubectl()
        const provisioner = new RecordingProvisioner()
        await EnvironmentHiveDatabaseSecret.Ensure(kubectl as unknown as IKubectl, 'sales-eu', provisioner)
        const password = kubectl.Password('sales-eu')
        assert.ok(password !== undefined && password.length >= 24)
        assert.deepEqual(provisioner.Ensured, [['sales-eu', password]])
        assert.equal(kubectl.Url('sales-eu'), EnvironmentHiveDatabase.UrlOf('sales-eu', password))
        await EnvironmentHiveDatabaseSecret.Ensure(kubectl as unknown as IKubectl, 'sales-eu', provisioner)
        assert.deepEqual(provisioner.Ensured, [['sales-eu', password], ['sales-eu', password]], 'a second bring-up reuses the stored password')
        assert.equal(kubectl.Creates, 1)
    })

    it('a failed provisioning writes no Secret, and the retry completes', async () =>
    {
        const kubectl = new SecretKubectl()
        const provisioner = new RecordingProvisioner(1)
        await assert.rejects(EnvironmentHiveDatabaseSecret.Ensure(kubectl as unknown as IKubectl, 'sales-eu', provisioner), /terminated/)
        assert.equal(kubectl.Password('sales-eu'), undefined)
        await EnvironmentHiveDatabaseSecret.Ensure(kubectl as unknown as IKubectl, 'sales-eu', provisioner)
        assert.deepEqual(provisioner.Ensured, [['sales-eu', kubectl.Password('sales-eu')]])
    })

    it('a create lost to a rival bring-up sets the role to the stored password', async () =>
    {
        const theirs = Buffer.from('theirs-password-0123456789', 'utf8').toString('base64')
        const kubectl = new SecretKubectl({ password: theirs, 'database-url': theirs })
        const provisioner = new RecordingProvisioner()
        await EnvironmentHiveDatabaseSecret.Ensure(kubectl as unknown as IKubectl, 'sales-eu', provisioner)
        assert.equal(provisioner.Ensured.length, 2)
        assert.deepEqual(provisioner.Ensured[1], ['sales-eu', 'theirs-password-0123456789'])
    })
})

describe('InClusterEnvironmentRuntime on the hive Postgres', () =>
{
    class Harness
    {
        public readonly Kubectl = new SecretKubectl()
        public readonly Applied: string[] = []
        public readonly TornDown: string[] = []

        public Runtime(provisioner?: IEnvironmentDatabaseProvisioner): InClusterEnvironmentRuntime
        {
            const orchestrator = {
                Kubectl: this.Kubectl,
                Apply: async (w: EnvironmentWorkload) => { this.Applied.push(w.environmentName) },
                Teardown: async (w: EnvironmentWorkload) => { this.TornDown.push(w.environmentName) },
            } as unknown as IHiveOrchestrator
            const orchestrators = { For: () => orchestrator } as unknown as HiveOrchestratorFactory
            const placement = { WorkloadFor: () => EngineFixture.Workload() } as unknown as EnvironmentPlacement
            const directory = { GetHive: () => EngineFixture.Hive() } as unknown as ITenantDirectory
            return new InClusterEnvironmentRuntime(orchestrators, placement, directory, {} as IBundleBuilder, undefined, provisioner)
        }

        public static Context(): EnvRuntimeContext
        {
            return { record: { name: EngineFixture.EnvName, hiveId: 'hive-1' }, def: { environmentId: 't1' }, bundleDir: 'b' } as unknown as EnvRuntimeContext
        }
    }

    it('a bring-up provisions the database after the apply; deletion drops it', async () =>
    {
        const harness = new Harness()
        const provisioner = new RecordingProvisioner()
        const runtime = harness.Runtime(provisioner)
        await assert.rejects(runtime.BringUp(Harness.Context()), (err: unknown) => err instanceof InClusterOperationFailedError)
        // The bundle step after provisioning fails on the test's empty bundle folder; provisioning has happened by then.
        assert.deepEqual(harness.Applied, [EngineFixture.EnvName])
        assert.equal(provisioner.Ensured.length, 1)
        assert.notEqual(harness.Kubectl.Password(EngineFixture.EnvName), undefined)
        await runtime.Teardown(Harness.Context(), false)
        assert.deepEqual(provisioner.Dropped, [], 'a teardown that keeps the data keeps the database')
        await runtime.Teardown(Harness.Context(), true)
        assert.deepEqual(provisioner.Dropped, [EngineFixture.EnvName])
    })

    it('without a provisioner the bring-up fails closed', async () =>
    {
        const runtime = new Harness().Runtime()
        await assert.rejects(runtime.BringUp(Harness.Context()), (err: unknown) =>
            err instanceof InClusterOperationFailedError && (err.Detail ?? '').includes(new HiveDatabaseUnavailableError().message))
    })
})
