import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { TenantAdminWorkloadSpec } from '../tenant-admin-workload.js'

class EntryFixture
{
    public static readonly Image = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + 'b'.repeat(64)
    public static readonly AgentDevImage = 'pragmatic-hive-agent:dev'
    public static readonly ReleasedAgentImage = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@sha256:' + 'c'.repeat(64)
    public static readonly HiveId = 'hive-a'
    public static readonly ChannelUrl = 'http://channel.example:7000'
    public static readonly AgentTokenSecret = 'agent-token-secret'
    public static readonly DeploymentKind = 'Deployment'

    public static Spec(): TenantAdminWorkloadSpec
    {
        return {
            tenantId: 'acme',
            hiveId: EntryFixture.HiveId,
            image: EntryFixture.Image,
            port: 8443,
            baseDomain: 'tenants.test',
            externalScheme: 'https',
            seedSecretName: 'acme-tenant-admin-seed',
            agentTokenSecretName: EntryFixture.AgentTokenSecret,
            rolloutUrl: EntryFixture.ChannelUrl,
        }
    }

    public static Container(): Record<string, unknown>
    {
        const doc = JSON.parse(new K8sManifestBuilder().RenderTenantAdmin(EntryFixture.Spec()))
        const deployment = doc.items.find((item: { kind: string }) => item.kind === EntryFixture.DeploymentKind)
        return deployment.spec.template.spec.containers[0]
    }
}

describe('K8sManifestBuilder tenant-admin entry', () =>
{
    it('names the hive agent\'s own dev image, never the env server\'s, and renders the agent with the image it is given', () =>
    {
        const F = EntryFixture
        assert.equal(K8sManifestBuilder.AgentImage, F.AgentDevImage)
        const doc = JSON.parse(new K8sManifestBuilder().RenderHiveAgent(F.HiveId, F.ChannelUrl, F.AgentTokenSecret, F.ReleasedAgentImage))
        const deployment = doc.items.find((item: { kind: string }) => item.kind === F.DeploymentKind)
        assert.equal(deployment.spec.template.spec.containers[0].image, F.ReleasedAgentImage)
    })

    it('runs the tenant-admin image by its own ENTRYPOINT: no command, no args (both image layouts run the same program)', () =>
    {
        const container = EntryFixture.Container()
        assert.equal(container.image, EntryFixture.Image)
        assert.equal(container.command, undefined)
        assert.equal(container.args, undefined)
        assert.ok(!JSON.stringify(container).includes('dist-tenant-admin'))
    })
})
