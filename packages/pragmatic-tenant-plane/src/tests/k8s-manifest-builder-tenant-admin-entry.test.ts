import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { TenantAdminWorkloadSpec } from '../tenant-admin-workload.js'

class EntryFixture
{
    public static readonly Image = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + 'b'.repeat(64)

    public static Spec(): TenantAdminWorkloadSpec
    {
        return {
            tenantId: 'acme',
            hiveId: 'hive-a',
            image: EntryFixture.Image,
            port: 8443,
            baseDomain: 'tenants.test',
            externalScheme: 'https',
            seedSecretName: 'acme-tenant-admin-seed',
            agentTokenSecretName: 'agent-token-secret',
            rolloutUrl: 'http://channel.example:7000',
        }
    }

    public static Container(): Record<string, unknown>
    {
        const doc = JSON.parse(new K8sManifestBuilder().RenderTenantAdmin(EntryFixture.Spec()))
        const deployment = doc.items.find((item: { kind: string }) => item.kind === 'Deployment')
        return deployment.spec.template.spec.containers[0]
    }
}

describe('K8sManifestBuilder tenant-admin entry', () =>
{
    it('runs the tenant-admin image by its own ENTRYPOINT: no command, no args (both image layouts run the same program)', () =>
    {
        const container = EntryFixture.Container()
        assert.equal(container.image, EntryFixture.Image)
        assert.equal(container.command, undefined)
        assert.equal(container.args, undefined)
        assert.ok(!JSON.stringify(container).includes('dist-tenant-admin'))
    })
})
