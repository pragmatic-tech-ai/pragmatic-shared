import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OciRegistryClient } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvironmentDatabaseSecret, EnvironmentWorkloadFactory } from '../environment-workload.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { InClusterRegistry } from '../in-cluster-registry.js'
import { EnvServerSeedSource } from '../env-server-seed.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

class WorkloadFixture
{
    public static readonly HiveId = 'hive-1'
    public static readonly EnvName = 'e1'
    public static readonly PlantedValue = 'planted-secret-value-token'
    public static readonly Image = 'pragmatic-env-server:dev'
    public static readonly DbImage = 'postgres:16'
    public static readonly ServerPort = 8080
    public static readonly AppName = 'crm'
    public static readonly AppVersion = '1.2.3'
    public static readonly TrustRef = 'trust-root-1'
    public static readonly NoTrustKeyRef = ''
    public static readonly HttpScheme = 'http://'
    public static readonly UiTrustSecret = 'e1-ui-trust'

    public static App()
    {
        return { appName: WorkloadFixture.AppName, appVersion: WorkloadFixture.AppVersion, repo: 'apps/crm', artifactTag: 'v1.2.3', manifestDigest: 'sha256:abc' }
    }

    public static Hive(): HiveRecord
    {
        return {
            id: WorkloadFixture.HiveId, tenantId: 't1', displayName: 'h',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: WorkloadFixture.PlantedValue },
            registry: { mode: InfraMode.Attach, credentialRef: WorkloadFixture.PlantedValue },
            createdAt: '2026-10-22T00:00:00Z',
        }
    }

    public static Env(template: Template, type: EnvType): EnvironmentRecord
    {
        return {
            name: WorkloadFixture.EnvName, type, template, environmentId: 't1', hiveId: WorkloadFixture.HiveId, hostPort: 8081,
            containerName: 'c', volumeName: 'v', bundleDir: WorkloadFixture.PlantedValue, createdAt: '2026-10-22T00:00:00Z', status: EnvStatus.Running,
        }
    }
}

describe('EnvironmentWorkloadFactory', () =>
{
    it('builds a database-bearing workload for runtime-postgres', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.RuntimePostgres, EnvType.Runtime), WorkloadFixture.Hive())
        assert.equal(w.environmentName, WorkloadFixture.EnvName)
        assert.equal(w.hiveId, WorkloadFixture.HiveId)
        assert.equal(w.image, WorkloadFixture.Image)
        assert.equal(w.serverPort, WorkloadFixture.ServerPort)
        assert.ok(w.database)
        assert.equal(w.database.image, WorkloadFixture.DbImage)
        assert.equal(typeof w.database.passwordRef, 'string')
        assert.ok(w.database.passwordRef.length > 0)
    })

    it('omits the database for dev-blank', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.database, undefined)
    })

    it('carries secret names only, never values', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.RuntimePostgres, EnvType.Runtime), WorkloadFixture.Hive())
        assert.ok(w.secretRefs.length > 0)
        for (const ref of w.secretRefs)
        {
            assert.equal(typeof ref, 'string')
            assert.notEqual(ref, WorkloadFixture.PlantedValue)
        }
        assert.ok(w.database)
        assert.notEqual(w.database.passwordRef, WorkloadFixture.PlantedValue)
        assert.ok(w.secretRefs.includes(w.database.passwordRef))
        assert.ok(!JSON.stringify(w).includes(WorkloadFixture.PlantedValue))
    })

    it('federates when the record carries an idpBaseDomain, referencing the ca.crt-only Secret', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), idpBaseDomain: 'hive.test' }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        assert.deepEqual(w.federation, { baseDomain: 'hive.test', caSecretName: EnvServerSeedSource.IdpCaSecretNameOf(WorkloadFixture.EnvName) })
    })

    it('has no federation when the record has no idpBaseDomain', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.federation, undefined)
    })

    it('maps record.appDeployment into the workload with registry base, trust secret and trust key', () =>
    {
        const app = WorkloadFixture.App()
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: app }
        const hive = { ...WorkloadFixture.Hive(), trustRootRef: WorkloadFixture.TrustRef }
        const w = EnvironmentWorkloadFactory.From(rec, hive)
        assert.deepEqual(w.appDeployment, {
            ...app,
            registryPullBase: WorkloadFixture.HttpScheme + InClusterRegistry.PullBase(),
            trustSecretName: EnvServerSeedSource.UiTrustSecretNameOf(WorkloadFixture.EnvName),
            trustKeyRef: WorkloadFixture.TrustRef,
            unpackImage: EnvironmentWorkloadFactory.UiUnpackImage,
        })
        assert.equal(EnvironmentWorkloadFactory.UiUnpackImage, 'pragmatic-ui-unpack:dev')
        assert.equal(EnvironmentWorkloadFactory.ServerImage, 'pragmatic-env-server:dev', 'the env server repository\'s own dev image')
        assert.deepEqual(EnvironmentWorkloadFactory.ImagesOf(w), [w.image, EnvironmentDatabaseSecret.DevImage, EnvironmentWorkloadFactory.UiUnpackImage])
        assert.equal(EnvServerSeedSource.UiTrustSecretNameOf(WorkloadFixture.EnvName), WorkloadFixture.UiTrustSecret)
    })

    it('registryPullBase is an absolute http URL a pod-side OciRegistryClient can use', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: WorkloadFixture.App() }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        const base = w.appDeployment!.registryPullBase
        assert.ok(base.startsWith(WorkloadFixture.HttpScheme))
        assert.equal(new URL(base + '/v2/').protocol, 'http:')
        assert.doesNotThrow(() => new OciRegistryClient(base))
    })

    it('falls back to the empty trust key ref when the hive has no trustRootRef', () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: WorkloadFixture.App() }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        assert.equal(w.appDeployment!.trustKeyRef, WorkloadFixture.NoTrustKeyRef)
    })

    it('has no appDeployment when the record has none', () =>
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive())
        assert.equal(w.appDeployment, undefined)
        assert.deepEqual(EnvironmentWorkloadFactory.ImagesOf(w), [w.image, EnvironmentDatabaseSecret.DevImage])
    })

    it('a released platform\'s pragmatic-postgres image becomes the server database image (and one of ImagesOf)', () =>
    {
        const release = 'ghcr.io/pragmatic-tech-ai/pragmatic-postgres@sha256:' + 'b'.repeat(64)
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.DevBlank, EnvType.Development), WorkloadFixture.Hive(), undefined, release)
        assert.equal(w.serverDatabase.image, release)
        assert.deepEqual(EnvironmentWorkloadFactory.ImagesOf(w), [w.image, release])
    })

    it('WithImages maps every platform image, in ImagesOf order, and nothing else', async () =>
    {
        const rec = { ...WorkloadFixture.Env(Template.DevBlank, EnvType.Development), appDeployment: WorkloadFixture.App() }
        const w = EnvironmentWorkloadFactory.From(rec, WorkloadFixture.Hive())
        const seen: string[] = []
        const mapped = await EnvironmentWorkloadFactory.WithImages(w, async image =>
        {
            seen.push(image)
            return 'reg/' + image
        })
        assert.deepEqual(seen, EnvironmentWorkloadFactory.ImagesOf(w))
        assert.deepEqual(EnvironmentWorkloadFactory.ImagesOf(mapped), EnvironmentWorkloadFactory.ImagesOf(w).map(i => 'reg/' + i))
        assert.deepEqual({ ...mapped, image: w.image, serverDatabase: w.serverDatabase, appDeployment: w.appDeployment }, w)
        assert.equal(w.image, EnvironmentWorkloadFactory.ServerImage, 'the input workload is not changed')
    })
})

class ServerDatabaseFixture
{
    public static readonly SecretName = 'e1-postgres'
    public static readonly UrlFile = '/run/secrets/pragmatic-env-server/database-url'
    public static readonly UrlFileVar = 'PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE'
    public static readonly UrlMount = '/run/secrets/pragmatic-env-server'
    public static readonly ApplicationsLine = 'pragmatic-env-server env_server env_server'
    public static readonly LoopbackArg = 'listen_addresses=127.0.0.1'

    /** The rendered List's items for a runtime-postgres workload (so the template's data-source database renders beside it). */
    public static Items(): any[]
    {
        const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(Template.RuntimePostgres, EnvType.Runtime), WorkloadFixture.Hive())
        return JSON.parse(new K8sManifestBuilder().Render(w)).items as any[]
    }

    public static Deployment(items: any[]): any
    {
        return items.find(i => i.kind === 'Deployment' && i.metadata.name === K8sManifestBuilder.ServerDeploymentOf(WorkloadFixture.EnvName))
    }
}

describe('the env server database', () =>
{
    it('the factory gives every environment its own pragmatic-postgres and its <env>-postgres Secret', () =>
    {
        for (const [template, type] of [[Template.DevBlank, EnvType.Development], [Template.RuntimePostgres, EnvType.Runtime]] as const)
        {
            const w = EnvironmentWorkloadFactory.From(WorkloadFixture.Env(template, type), WorkloadFixture.Hive())
            assert.deepEqual(w.serverDatabase, { image: EnvironmentDatabaseSecret.DevImage, secretName: ServerDatabaseFixture.SecretName })
        }
        assert.equal(EnvironmentDatabaseSecret.DevImage, 'pragmatic-postgres:local')
        assert.equal(EnvironmentDatabaseSecret.NameOf(WorkloadFixture.EnvName), ServerDatabaseFixture.SecretName)
        assert.equal(EnvironmentDatabaseSecret.ApplicationsLine(), ServerDatabaseFixture.ApplicationsLine)
        assert.equal(EnvironmentDatabaseSecret.UrlOf('pw'), 'postgres://env_server:pw@127.0.0.1:5432/env_server')
    })

    it('mints a superuser password, a role password and the URL carrying the role password', () =>
    {
        const S = EnvironmentDatabaseSecret
        const data = S.Mint()
        assert.deepEqual([...data.keys()].sort(), ['database-url', 'password', 'superuser'])
        const password = data.get(S.PasswordKey)!.toString('utf8')
        assert.equal(data.get(S.UrlKey)!.toString('utf8'), S.UrlOf(password))
        assert.notEqual(data.get(S.SuperuserKey)!.toString('utf8'), password)
        assert.notEqual(S.Mint().get(S.PasswordKey)!.toString('utf8'), password, 'every mint is fresh')
    })

    it('an environment workload carries a pragmatic-postgres sidecar bound to 127.0.0.1 and the URL file setting', () =>
    {
        const F = ServerDatabaseFixture
        const items = F.Items()
        const spec = F.Deployment(items).spec.template.spec
        const [server, postgres] = spec.containers
        assert.equal(server.name, K8sManifestBuilder.ServerContainerName)
        assert.equal(postgres.name, 'postgres')
        assert.equal(postgres.image, EnvironmentDatabaseSecret.DevImage)
        assert.deepEqual(postgres.args, ['postgres', '-c', F.LoopbackArg])
        assert.equal(postgres.ports, undefined, 'no port: the pod loopback only')
        assert.equal(postgres.securityContext.runAsUser, 999)
        assert.equal(postgres.securityContext.runAsNonRoot, true)
        assert.equal(postgres.securityContext.readOnlyRootFilesystem, true)
        const dataMount = postgres.volumeMounts.find((m: any) => m.mountPath === '/var/lib/postgresql/data')
        assert.equal(dataMount.name, 'data')
        assert.equal(dataMount.subPath, '.postgres', 'dot-led: never an environment folder')
        const dataVolume = spec.volumes.find((v: any) => v.name === dataMount.name)
        assert.equal(dataVolume.persistentVolumeClaim.claimName, K8sManifestBuilder.ServerDataClaimNameOf(WorkloadFixture.EnvName), 'the environment\'s own data claim')
        assert.ok(postgres.volumeMounts.some((m: any) => m.mountPath === '/tmp'), 'a scratch tmpfs beside the read-only root')
        const secrets = spec.volumes.find((v: any) => v.name === 'postgres-secrets').secret
        assert.equal(secrets.secretName, F.SecretName)
        assert.deepEqual(secrets.items, [{ key: 'superuser', path: 'superuser' }, { key: 'password', path: 'applications/pragmatic-env-server' }])
        const configName = spec.volumes.find((v: any) => v.name === 'postgres-config').configMap.name
        const config = items.find(i => i.kind === 'ConfigMap' && i.metadata.name === configName)
        assert.equal(configName, F.SecretName)
        assert.equal(config.metadata.namespace, K8sManifestBuilder.NamespaceOf(WorkloadFixture.EnvName))
        assert.deepEqual(config.data, { 'applications.conf': F.ApplicationsLine + '\n' })
        assert.ok(server.env.some((e: any) => e.name === F.UrlFileVar && e.value === F.UrlFile))
        const urlMount = server.volumeMounts.find((m: any) => m.mountPath === F.UrlMount)
        assert.equal(urlMount.readOnly, true)
        const url = spec.volumes.find((v: any) => v.name === urlMount.name).secret
        assert.equal(url.secretName, F.SecretName)
        assert.deepEqual(url.items, [{ key: 'database-url', path: 'database-url' }], 'the server sees the URL only, never the superuser password')
        assert.equal(K8sManifestBuilder.EnvServerDatabaseUrlFile, F.UrlFile)
        assert.ok(items.some(i => i.kind === 'StatefulSet'), 'the template\'s data-source database stays as it is')
    })

    it('the database secret is referenced, never inlined', () =>
    {
        const items = ServerDatabaseFixture.Items()
        const yaml = JSON.stringify(items)
        assert.ok(!items.some(i => i.kind === 'Secret' && i.metadata.name === ServerDatabaseFixture.SecretName), 'the manifest never carries the Secret')
        assert.ok(!yaml.includes('postgres://'), 'no database URL value')
        const spec = ServerDatabaseFixture.Deployment(items).spec.template.spec
        for (const container of spec.containers)
        {
            for (const e of container.env ?? [])
            {
                assert.ok(!/PASSWORD/.test(e.name) || e.valueFrom !== undefined, 'no inline password variable')
            }
        }
    })

    it('the environment deployment recreates instead of rolling (one Postgres per data folder)', () =>
    {
        const deployment = ServerDatabaseFixture.Deployment(ServerDatabaseFixture.Items())
        assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' })
    })
})
