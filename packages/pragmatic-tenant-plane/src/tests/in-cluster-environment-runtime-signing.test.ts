import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterEnvironmentRuntime, InClusterOperationFailedError, type IHiveImageSigner } from '../in-cluster-environment-runtime.js'
import { EnvironmentWorkloadFactory, type EnvironmentWorkload } from '../environment-workload.js'
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
    public static readonly ServerImage = 'pragmatic-server:dev'
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
            serverPort: 8080, env: {}, secretRefs: [],
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
