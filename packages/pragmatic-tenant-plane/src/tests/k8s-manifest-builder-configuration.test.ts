import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { ComponentConfigurationMounts } from '../component-configuration-mounts.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { IdpWorkloadSpec } from '../idp-workload-driver.js'
import type { TenantAdminWorkloadSpec } from '../tenant-admin-workload.js'

type Obj = Record<string, any>

/** Every hive workload the builder renders, with the component each container runs. */
class ConfigurationFixture
{
    public static readonly HiveId = 'hive-a'
    public static readonly TenantId = 'acme'

    public static Workload(): EnvironmentWorkload
    {
        return {
            environmentName: 'dev1',
            environmentId: 'env-dev1-id',
            hiveId: ConfigurationFixture.HiveId,
            image: 'pragmatic-server:dev',
            serverPort: 8080,
            env: { PRAGMATIC_PORT: '8080' },
            secretRefs: [],
            appDeployment: {
                appName: 'crm',
                appVersion: '1.2.3',
                registryPullBase: 'localhost:30500',
                repo: 'apps/crm',
                artifactTag: 'v1.2.3',
                manifestDigest: 'sha256:abc',
                trustSecretName: 'dev1-ui-trust',
                trustKeyRef: 'hive-root',
                unpackImage: 'localhost:5000/pragmatic-ui-unpack:dev',
            },
        }
    }

    public static Idp(): IdpWorkloadSpec
    {
        return {
            tenantId: ConfigurationFixture.TenantId, hiveId: ConfigurationFixture.HiveId, image: 'pragmatic-tenant-idp:dev', port: 9443,
            adminTokenSecretName: 'idp-admin-secret', adminTokenRef: 'admin-token', tlsSecretName: 'idp-tls-secret',
            database: { image: 'pragmatic-postgres:local', secretName: 'pragmatic-idp-acme-postgres' },
        }
    }

    public static TenantAdmin(): TenantAdminWorkloadSpec
    {
        return {
            tenantId: ConfigurationFixture.TenantId,
            hiveId: ConfigurationFixture.HiveId,
            image: 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + 'b'.repeat(64),
            port: 8443,
            baseDomain: 'tenants.test',
            externalScheme: 'https',
            seedSecretName: 'acme-tenant-admin-seed',
            agentTokenSecretName: 'agent-token-secret',
            rolloutUrl: 'http://channel.example:7000',
        }
    }

    public static Items(text: string): Obj[]
    {
        return JSON.parse(text).items
    }

    /** Each rendered Deployment, with the components its containers run (container name -> component). */
    public static Deployments(): Array<{ Deployment: Obj; Components: Record<string, string> }>
    {
        const builder = new K8sManifestBuilder()
        const F = ConfigurationFixture
        const deployment = (text: string): Obj => F.Items(text).find(item => item.kind === 'Deployment')
        return [
            { Deployment: deployment(builder.RenderHiveAgent(F.HiveId, 'http://channel.example:7000', 'agent-token-secret', 'pragmatic-hive-agent:dev')), Components: { agent: 'pragmatic-hive-agent' } },
            { Deployment: deployment(builder.RenderIdp(F.Idp())), Components: { idp: 'pragmatic-tenant-idp' } },
            { Deployment: deployment(builder.RenderTenantAdmin(F.TenantAdmin())), Components: { 'tenant-admin': 'pragmatic-tenant-admin' } },
            { Deployment: F.Items(builder.Render(F.Workload())).find(item => item.kind === 'Deployment' && item.spec.template.spec.initContainers), Components: { server: 'pragmatic-env-server', 'ui-unpack': 'pragmatic-ui-unpack' } },
        ]
    }

    public static Container(deployment: Obj, name: string): Obj
    {
        const pod = deployment.spec.template.spec
        return [...pod.containers, ...(pod.initContainers ?? [])].find((c: Obj) => c.name === name)
    }

    public static VolumeOf(deployment: Obj, mount: Obj): Obj
    {
        return deployment.spec.template.spec.volumes.find((v: Obj) => v.name === mount.name)
    }
}

describe('K8sManifestBuilder configuration mounts', () =>
{
    it('every workload the builder renders mounts pragmatic-config-<its component> optionally', () =>
    {
        const F = ConfigurationFixture
        for (const { Deployment, Components } of F.Deployments())
        {
            for (const [container, component] of Object.entries(Components))
            {
                const mounts: Obj[] = F.Container(Deployment, container).volumeMounts
                const config = mounts.find(m => m.mountPath === '/etc/pragmatic/configuration')
                assert.ok(config, `${component} mounts its configuration`)
                assert.equal(config.readOnly, true)
                assert.deepEqual(F.VolumeOf(Deployment, config).configMap, { name: `pragmatic-config-${component}`, optional: true }, component)
                const store = mounts.find(m => m.mountPath === `/run/secrets/pragmatic/${component}`)
                assert.ok(store, `${component} mounts its secret store`)
                assert.equal(store.readOnly, true)
                const secret = F.VolumeOf(Deployment, store).secret
                assert.equal(secret.secretName, `pragmatic-secrets-${component}`)
                assert.equal(secret.optional, true)
                assert.equal(mounts.filter(m => m.mountPath === '/etc/pragmatic/configuration').length, 1, `${component}: one configuration mount`)
            }
            const names = Deployment.spec.template.spec.volumes.map((v: Obj) => v.name)
            assert.equal(new Set(names).size, names.length, 'volume names are unique')
            assert.ok(names.every((n: string) => n.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(n)), 'volume names are DNS labels')
        }
    })

    it('every workload carries the component and managed-by labels, never in its selector', () =>
    {
        for (const { Deployment, Components } of ConfigurationFixture.Deployments())
        {
            const [primary] = Object.values(Components)
            for (const labels of [Deployment.metadata.labels, Deployment.spec.template.metadata.labels])
            {
                assert.equal(labels['app.kubernetes.io/component'], primary)
                assert.equal(labels['app.kubernetes.io/managed-by'], 'pragmatic-tenant-admin')
                for (const [container, component] of Object.entries(Components))
                {
                    assert.equal(labels[`component.pragmatic-tech.ai/${component}`], container, component)
                    assert.equal(ComponentConfigurationMounts.ContainerOf(labels, component), container)
                }
            }
            const selector = Deployment.spec.selector.matchLabels
            assert.ok(!Object.keys(selector).some(k => k.startsWith('app.kubernetes.io/') || k.startsWith('component.pragmatic-tech.ai/')), 'the selector is unchanged')
            for (const [key, value] of Object.entries(selector)) assert.equal(Deployment.spec.template.metadata.labels[key], value)
        }
    })

    it('the secrets tmpfs is memory-backed, per container', () =>
    {
        const F = ConfigurationFixture
        for (const { Deployment, Components } of F.Deployments())
        {
            const seen = new Set<string>()
            for (const container of Object.keys(Components))
            {
                const run = F.Container(Deployment, container).volumeMounts.find((m: Obj) => m.mountPath === '/run/pragmatic/secrets')
                assert.ok(run, container)
                assert.equal(run.readOnly, undefined, 'the start step writes there')
                assert.equal(F.VolumeOf(Deployment, run).emptyDir.medium, 'Memory')
                assert.ok(!seen.has(run.name), 'no two containers share it')
                seen.add(run.name)
            }
        }
    })

    it('deployments roll with maxUnavailable 0', () =>
    {
        for (const { Deployment } of ConfigurationFixture.Deployments())
        {
            assert.deepEqual(Deployment.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } })
        }
    })

    it('the console may configure the hive components in pragmatic-system and the IdP namespace by name only', () =>
    {
        const F = ConfigurationFixture
        const builder = new K8sManifestBuilder()
        const role = (items: Obj[]): Obj => items.find(i => i.kind === 'Role' && i.metadata.name === K8sManifestBuilder.TenantConsoleConfigurationRoleNameOf(F.TenantId))
        const system = role(F.Items(builder.RenderTenantAdmin(F.TenantAdmin())))
        assert.equal(system.metadata.namespace, 'pragmatic-system')
        const named = (r: Obj, resource: string, verb: string): string[] => r.rules.filter((rule: Obj) => rule.resources.includes(resource) && rule.verbs.includes(verb)).flatMap((rule: Obj) => rule.resourceNames ?? ['*'])
        assert.deepEqual(named(system, 'configmaps', 'patch'), ['pragmatic-config-pragmatic-hive-agent', 'pragmatic-config-pragmatic-tenant-admin'])
        assert.deepEqual(named(system, 'secrets', 'get'), ['pragmatic-secrets-pragmatic-hive-agent', 'pragmatic-secrets-pragmatic-tenant-admin'])
        assert.deepEqual(named(system, 'deployments', 'patch'), [K8sManifestBuilder.HiveAgentNameOf(F.HiveId), K8sManifestBuilder.TenantAdminNameOf(F.TenantId)])
        const idpItems = F.Items(builder.RenderIdp(F.Idp()))
        const idp = role(idpItems)
        assert.equal(idp.metadata.namespace, K8sManifestBuilder.IdpNameOf(F.TenantId))
        assert.deepEqual(named(idp, 'configmaps', 'patch'), ['pragmatic-config-pragmatic-tenant-idp'])
        const binding = idpItems.find(i => i.kind === 'RoleBinding')
        assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: K8sManifestBuilder.TenantAdminNameOf(F.TenantId), namespace: 'pragmatic-system' }])
        const removal = F.Items(builder.TenantConsoleRemovalManifest(F.TenantId, F.HiveId))
        const roles = removal.filter(i => i.metadata.name === K8sManifestBuilder.TenantConsoleConfigurationRoleNameOf(F.TenantId)).map(i => `${i.kind}/${i.metadata.namespace}`)
        assert.deepEqual(roles.sort(), ['Role/pragmatic-idp-acme', 'Role/pragmatic-system', 'RoleBinding/pragmatic-idp-acme', 'RoleBinding/pragmatic-system'].sort())
    })

    it('the selector of a component finds it by its component label and the console as manager', () =>
    {
        assert.equal(ComponentConfigurationMounts.SelectorOf('pragmatic-ui-unpack'), 'component.pragmatic-tech.ai/pragmatic-ui-unpack,app.kubernetes.io/managed-by=pragmatic-tenant-admin')
        assert.equal(ComponentConfigurationMounts.ContainerOf({}, 'pragmatic-ui-unpack'), undefined)
    })
})
