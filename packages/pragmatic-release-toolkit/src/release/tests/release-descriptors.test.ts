import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { ComponentDescriptorBuilder } from '@pragmatic-tech-ai/pragmatic-component'
import { ReleaseComponentDescriptors, ReleaseDescriptorMismatchError, ReleaseDescriptorsAbsentError, ReleaseDescriptorUnverifiedError } from '../release-component-descriptors.js'
import { ReleaseComponentsArtifact } from '../release-components-artifact.js'
import { ReleaseDescriptorCodec } from '../release-descriptor.js'
import { ReleaseManifest } from '../release-manifest.js'
import { ReleasePublisher, type ReleasePublishResult } from '../release-publisher.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'
import { ReleaseWorld } from './release-manifest-fixture.js'

class DescriptorKeys
{
    public readonly Private: string
    public readonly Public: string

    public constructor()
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

class OneKeyTrust
{
    public constructor(private readonly id: string, private readonly pem: string)
    {
    }

    public KeyFor(keyId: string): string | undefined
    {
        return keyId === this.id ? this.pem : undefined
    }
}

class PublishedRelease
{
    public static readonly KeyId = 'release-2026-11'
    public static readonly ReleaseCommit = 'c'.repeat(40)
    public static readonly DescriptorRepo = ReleaseWorld.Namespace + '/' + ReleasePublisher.DescriptorRepository
    public static readonly OlderVersion = '0.1.0-early.5'
    public static readonly MethodPut = 'PUT'

    public readonly World = new ReleaseWorld()
    public readonly Key = new DescriptorKeys()

    public async Publish(): Promise<ReleasePublishResult>
    {
        const publisher = new ReleasePublisher(this.World.Client(), ReleaseWorld.Namespace)
        return publisher.PublishManifest({
            Manifest: ReleaseManifest.Parse(this.World.ManifestText()),
            Assets: this.World.Assets,
            ReleaseCommit: PublishedRelease.ReleaseCommit,
            SigningKeyId: PublishedRelease.KeyId,
            PrivateKeyPem: this.Key.Private,
            TrustedPublicKeyPem: this.Key.Public,
        })
    }

    public Reader(trusted: string = this.Key.Public): ReleaseComponentDescriptors
    {
        return new ReleaseComponentDescriptors(this.World.Client(), new OneKeyTrust(PublishedRelease.KeyId, trusted), ReleaseWorld.Namespace)
    }
}

describe('ReleaseComponentDescriptors: the descriptors a platform release carries', () =>
{
    it('a published release returns nine descriptors whose digests equal the signed ones', async () =>
    {
        const r = new PublishedRelease()
        const { descriptor } = await r.Publish()
        const set = await r.Reader().Descriptors(ReleaseWorld.ReleaseVersion)
        assert.equal(set.All().length, 9)
        assert.equal(ReleaseApps.All.length, 9)
        for (const [app, image] of ReleaseDescriptorCodec.ImagesOf(descriptor))
        {
            const carried = set.Get(app)
            assert.ok(carried !== undefined, app)
            assert.equal(carried.Name, app)
            assert.equal(carried.Version, ReleaseWorld.ComponentVersion)
            assert.equal(carried.ContentDigest(), image.componentDigest, app)
            assert.equal(image.componentDigest, r.World.ComponentDigests.get(app))
        }
    })

    it('carries them as one artifact beside the single-layer release descriptor, pushed before it', async () =>
    {
        const r = new PublishedRelease()
        await r.Publish()
        const client = r.World.Client()
        const release = await client.PullArtifactLayer(PublishedRelease.DescriptorRepo, ReleaseWorld.ReleaseVersion)
        assert.ok(release.layer.length > 0, 'the release descriptor still reads as a single-layer artifact')
        const tag = ReleaseComponentsArtifact.TagOf(ReleaseWorld.ReleaseVersion)
        assert.equal(tag, 'components-0.1.0-early.6')
        const artifact = await client.PullArtifactLayers(PublishedRelease.DescriptorRepo, tag)
        assert.ok(artifact !== undefined)
        assert.deepEqual(artifact.layers.map(l => l.annotations['org.opencontainers.image.title']), ReleaseApps.All.map(app => app + '.json'))
        assert.ok(artifact.layers.every(l => l.mediaType === 'application/vnd.pragmatic.component.v1+json'))
        const manifestPuts = r.World.Registry.Requests.filter(q => q.method === PublishedRelease.MethodPut && q.url.includes(PublishedRelease.DescriptorRepo + '/manifests/'))
        assert.deepEqual(manifestPuts.map(q => q.url.slice(q.url.lastIndexOf('/') + 1)), [tag, ReleaseWorld.ReleaseVersion])
    })

    it('a tampered layer is refused naming the app', async () =>
    {
        const r = new PublishedRelease()
        await r.Publish()
        const client = r.World.Client()
        const tag = ReleaseComponentsArtifact.TagOf(ReleaseWorld.ReleaseVersion)
        const original = await client.PullArtifactLayers(PublishedRelease.DescriptorRepo, tag)
        assert.ok(original !== undefined)
        const forged = new TextEncoder().encode(new ComponentDescriptorBuilder(ReleaseApp.HiveAgent, '0.9.9').Build().ToCanonicalJson())
        const layers = original.layers.map(l => l.annotations[ReleaseComponentsArtifact.TitleAnnotation] === ReleaseComponentsArtifact.TitleOf(ReleaseApp.HiveAgent)
            ? { mediaType: l.mediaType, bytes: forged, annotations: l.annotations }
            : { mediaType: l.mediaType, bytes: l.bytes, annotations: l.annotations })
        await client.PushLayeredArtifact(PublishedRelease.DescriptorRepo, tag, ReleaseComponentsArtifact.ArtifactType, layers, original.annotations)
        await assert.rejects(r.Reader().Descriptors(ReleaseWorld.ReleaseVersion), (e: unknown) =>
            e instanceof ReleaseDescriptorMismatchError && e.App === ReleaseApp.HiveAgent && e.Signed === r.World.ComponentDigests.get(ReleaseApp.HiveAgent)
            && e.Actual !== undefined && e.Actual !== e.Signed && e.message.includes(ReleaseApp.HiveAgent))
    })

    it('a release missing one app\'s layer is refused naming the app', async () =>
    {
        const r = new PublishedRelease()
        await r.Publish()
        const client = r.World.Client()
        const tag = ReleaseComponentsArtifact.TagOf(ReleaseWorld.ReleaseVersion)
        const original = await client.PullArtifactLayers(PublishedRelease.DescriptorRepo, tag)
        assert.ok(original !== undefined)
        const kept = original.layers.filter(l => l.annotations[ReleaseComponentsArtifact.TitleAnnotation] !== ReleaseComponentsArtifact.TitleOf(ReleaseApp.TenantIdp))
        await client.PushLayeredArtifact(PublishedRelease.DescriptorRepo, tag, ReleaseComponentsArtifact.ArtifactType, kept.map(l => ({ mediaType: l.mediaType, bytes: l.bytes, annotations: l.annotations })), {})
        await assert.rejects(r.Reader().Descriptors(ReleaseWorld.ReleaseVersion), (e: unknown) =>
            e instanceof ReleaseDescriptorMismatchError && e.App === ReleaseApp.TenantIdp && e.Actual === undefined)
    })

    it('an older release without layers answers ReleaseDescriptorsAbsentError', async () =>
    {
        const r = new PublishedRelease()
        await r.Publish()
        const client = r.World.Client()
        // The same signed descriptor under another version, as releases published before the descriptors were: no components artifact.
        const release = await client.PullArtifactLayer(PublishedRelease.DescriptorRepo, ReleaseWorld.ReleaseVersion)
        await client.PushArtifact(PublishedRelease.DescriptorRepo, PublishedRelease.OlderVersion, ReleasePublisher.ArtifactType, ReleasePublisher.LayerMediaType, release.layer, release.annotations)
        await assert.rejects(r.Reader().Descriptors(PublishedRelease.OlderVersion), (e: unknown) =>
            e instanceof ReleaseDescriptorsAbsentError && e.Version === PublishedRelease.OlderVersion)
    })

    it('a release descriptor no trusted key signed is refused before anything it binds is read', async () =>
    {
        const r = new PublishedRelease()
        await r.Publish()
        await assert.rejects(r.Reader(new DescriptorKeys().Public).Descriptors(ReleaseWorld.ReleaseVersion), (e: unknown) => e instanceof ReleaseDescriptorUnverifiedError)
    })

    it('an absent multi-layer artifact pulls as undefined', async () =>
    {
        const r = new PublishedRelease()
        assert.equal(await r.World.Client().PullArtifactLayers(PublishedRelease.DescriptorRepo, 'components-9.9.9'), undefined)
    })
})
