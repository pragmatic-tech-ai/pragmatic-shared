import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InClusterEnvironmentRuntime, InClusterOperationFailedError, type IHiveImageSigner } from '../in-cluster-environment-runtime.js'
import { EnvironmentDatabaseSecret, EnvironmentWorkloadFactory, type EnvironmentWorkload } from '../environment-workload.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { EnvRuntimeContext } from '../environment-runtime.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import type { IBundleBuilder } from '../environment-seed-port.js'
import type { HiveRecord } from '../platform-records.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'

/** Records what it signs; signs for every hive. */
class RecordingSigner implements IHiveImageSigner
{
    public readonly Signed: string[] = []

    public SignsFor(_hive: HiveRecord): boolean
    {
        return true
    }

    public async Sign(imageRef: string): Promise<void>
    {
        this.Signed.push(imageRef)
    }
}

/** Refuses its Apply (so BringUp stops there) and records how many images were signed by then. */
class RefusingOrchestrator
{
    public SignedAtApply: number | undefined = undefined

    public constructor(private readonly signer: RecordingSigner)
    {
    }

    public async Apply(): Promise<void>
    {
        this.SignedAtApply = this.signer.Signed.length
        throw new Error(SigningFixture.ApplyRefused)
    }
}

class SigningFixture
{
    public static readonly HiveId = 'hive-a'
    public static readonly TenantId = 'acme'
    public static readonly EnvName = 'dev1'
    public static readonly EnvId = 'dev1-id'
    public static readonly ServerImage = EnvironmentWorkloadFactory.ServerImage
    public static readonly Registry = 'reg.local:5000'
    public static readonly Slash = '/'
    public static readonly ApplyRefused = 'apply refused (the test stops here)'
    public static readonly CreatedAt = '2026-11-21T00:00:00.000Z'

    public static readonly Hive: HiveRecord = {
        id: SigningFixture.HiveId, tenantId: SigningFixture.TenantId, displayName: SigningFixture.HiveId,
        cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
        registry: { mode: InfraMode.Attach, endpoint: SigningFixture.Registry },
        createdAt: SigningFixture.CreatedAt,
    }

    public static Workload(withApp: boolean): EnvironmentWorkload
    {
        const workload: EnvironmentWorkload = {
            environmentName: SigningFixture.EnvName, environmentId: SigningFixture.EnvId, hiveId: SigningFixture.HiveId, image: SigningFixture.ServerImage,
            serverPort: 8080, env: {}, secretRefs: [], serverDatabase: { image: 'pragmatic-postgres:local', secretName: 'dev1-postgres' },
        }
        if (withApp)
        {
            workload.appDeployment = {
                appName: 'crm', appVersion: '1.0.0', registryPullBase: 'http://reg:5000', repo: 'apps/crm', artifactTag: 'v1',
                manifestDigest: 'sha256:' + 'a'.repeat(64), trustSecretName: 'dev1-ui-trust', trustKeyRef: 'root-1',
                unpackImage: EnvironmentWorkloadFactory.UiUnpackImage,
            }
        }
        return workload
    }

    /** Brings the environment up until its orchestrator's Apply (which refuses, so nothing else runs); answers what was signed. */
    public static async SignedOnBringUp(withApp: boolean): Promise<string[]>
    {
        const signer = new RecordingSigner()
        const refusing = new RefusingOrchestrator(signer)
        const orchestrator = refusing as unknown as IHiveOrchestrator
        const orchestrators = { For: () => orchestrator } as unknown as HiveOrchestratorFactory
        const placement = { WorkloadFor: () => SigningFixture.Workload(withApp) } as unknown as EnvironmentPlacement
        const directory = { GetHive: () => SigningFixture.Hive } as unknown as ITenantDirectory
        const bundle = {} as IBundleBuilder
        const runtime = new InClusterEnvironmentRuntime(orchestrators, placement, directory, bundle, signer)
        const ctx = { record: { name: SigningFixture.EnvName, hiveId: SigningFixture.HiveId }, def: {}, bundleDir: SigningFixture.EnvId } as unknown as EnvRuntimeContext
        await assert.rejects(runtime.BringUp(ctx), (error: unknown) =>
            error instanceof InClusterOperationFailedError && (error.Detail ?? '').includes(SigningFixture.ApplyRefused))
        assert.equal(refusing.SignedAtApply, signer.Signed.length, 'every image is signed before the apply')
        return signer.Signed
    }
}

describe('InClusterEnvironmentRuntime signing', () =>
{
    it('signs the server image and, with an app deployment, the UI unpack image, as the hive pulls them, before the apply', async () =>
    {
        const S = SigningFixture
        assert.deepEqual(await S.SignedOnBringUp(false), [S.Registry + S.Slash + S.ServerImage])
        assert.deepEqual(await S.SignedOnBringUp(true), [S.Registry + S.Slash + S.ServerImage, S.Registry + S.Slash + EnvironmentWorkloadFactory.UiUnpackImage])
    })
})

/** A cluster's Secrets in memory: Find answers what was applied (by namespace + `secret/<name>`); every apply replaces, a
 *  create only adds an absent Secret. */
class SecretStoreKubectl
{
    public readonly Secrets = new Map<string, Record<string, string>>()
    public ServerSideApplies = 0
    public Creates = 0

    public async Create(manifestJson: string): Promise<boolean>
    {
        const item = JSON.parse(manifestJson)
        if (this.Secrets.has(item.metadata.namespace + ' secret/' + item.metadata.name))
        {
            return false
        }
        this.Creates++
        this.Store(item)
        return true
    }

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        const data = this.Secrets.get(namespace + ' ' + resource)
        return data === undefined ? undefined : JSON.stringify({ kind: 'Secret', data })
    }

    public async ApplyServerSide(manifestJson: string): Promise<void>
    {
        this.ServerSideApplies++
        this.Store(JSON.parse(manifestJson))
    }

    public async Apply(manifestJson: string): Promise<void>
    {
        const doc = JSON.parse(manifestJson)
        for (const item of doc.items ?? [doc])
        {
            this.Store(item)
        }
    }

    private Store(item: { kind: string; metadata: { name: string; namespace: string }; data: Record<string, string> }): void
    {
        if (item.kind === 'Secret')
        {
            this.Secrets.set(item.metadata.namespace + ' secret/' + item.metadata.name, item.data)
        }
    }
}

describe('InClusterEnvironmentRuntime server database', () =>
{
    it('creating an environment mints its database secret once', async () =>
    {
        const S = SigningFixture
        const bundleDir = mkdtempSync(join(tmpdir(), 'env-db-mint-'))
        try
        {
            writeFileSync(join(bundleDir, 'master.key'), 'MASTER')
            writeFileSync(join(bundleDir, 'provisioned-secrets.json'), '{}')
            writeFileSync(join(bundleDir, 'environments.json'), '{}')
            const kubectl = new SecretStoreKubectl()
            const orchestrator = { Kubectl: kubectl, Apply: async () => undefined } as unknown as IHiveOrchestrator
            const orchestrators = { For: () => orchestrator } as unknown as HiveOrchestratorFactory
            const placement = { WorkloadFor: () => S.Workload(false) } as unknown as EnvironmentPlacement
            const directory = { GetHive: () => S.Hive } as unknown as ITenantDirectory
            const runtime = new InClusterEnvironmentRuntime(orchestrators, placement, directory, {} as IBundleBuilder)
            const ctx = { record: { name: S.EnvName, hiveId: S.HiveId }, def: { environmentId: S.EnvId }, bundleDir } as unknown as EnvRuntimeContext
            const key = K8sManifestBuilder.NamespaceOf(S.EnvName) + ' secret/' + EnvironmentDatabaseSecret.NameOf(S.EnvName)

            await runtime.BringUp(ctx)
            const first = kubectl.Secrets.get(key)
            assert.ok(first, 'the first bring-up mints <env>-postgres')
            assert.deepEqual(Object.keys(first).sort(), ['database-url', 'password', 'superuser'])
            const password = Buffer.from(first.password!, 'base64').toString('utf8')
            assert.equal(Buffer.from(first['database-url']!, 'base64').toString('utf8'), EnvironmentDatabaseSecret.UrlOf(password))

            await runtime.BringUp(ctx)
            assert.deepEqual(kubectl.Secrets.get(key), first, 'a second bring-up keeps the first Secret\'s values')
            assert.equal(kubectl.Creates, 1, 'created once, never re-applied, never rotated')
            assert.equal(kubectl.ServerSideApplies, 0, 'a create-only write, never an apply that could overwrite')
        }
        finally
        {
            rmSync(bundleDir, { recursive: true, force: true })
        }
    })
})
