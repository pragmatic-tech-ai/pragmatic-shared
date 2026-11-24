import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { OciRegistryClient } from '../../oci-registry-client.js'
import { Channel } from '../../channel.js'
import { ReleaseDescriptorCodec, ReleaseDescriptorInvalidError, type ReleaseDescriptor, type ReleaseImage } from '../release-descriptor.js'
import { ReleaseManifest } from '../release-manifest.js'
import { ReleaseChartMismatchError, ReleasePublisher } from '../release-publisher.js'
import { ReleaseSignature } from '../release-signature.js'
import { ReleaseApps } from '../release-tag.js'
import { ReleaseWorld } from './release-manifest-fixture.js'

class Schema3Fixture
{
    public static readonly KeyId = 'release-2026-11'
    public static readonly Commit = 'c'.repeat(40)
    public static readonly Digest = 'sha256:' + 'd'.repeat(64)
    public static readonly OtherDigest = 'sha256:' + 'e'.repeat(64)
    public static readonly ChartRepo = ReleaseWorld.Namespace + '/' + ReleasePublisher.ChartRepository
    public static readonly ChartManifestType = 'application/vnd.oci.image.manifest.v1+json'

    public static Keys(): { Private: string; Public: string }
    {
        const pair = generateKeyPairSync('ed25519')
        return { Private: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), Public: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    }

    public static Descriptor(schema: 2 | 3, privateKey: string): ReleaseDescriptor
    {
        const images: Record<string, ReleaseImage> = {}
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: 'pragmatic-tech-ai/' + app, digest: Schema3Fixture.Digest, signature: ReleaseSignature.Sign(Schema3Fixture.Digest, privateKey), componentDigest: Schema3Fixture.Digest }
        }
        const descriptor: ReleaseDescriptor = {
            schema, version: '0.1.0-early.16', channel: Channel.EarlyAccess, serverCommit: Schema3Fixture.Commit, siblingCommits: {},
            builtAt: '2026-11-24T00:00:00.000Z', signingKeyId: Schema3Fixture.KeyId, images: images as ReleaseDescriptor['images'],
        }
        if (schema === 3)
        {
            descriptor.chart = { reference: ReleaseDescriptorCodec.ChartReference, version: '0.1.0-early.16', digest: Schema3Fixture.Digest }
        }
        return descriptor
    }

    /** The descriptor's digest, signed as the platform catalogue verifies it. */
    public static Verifies(bytes: Uint8Array, signature: string, publicKey: string): boolean
    {
        return ReleaseSignature.Verifies(OciRegistryClient.DigestOf(bytes), signature, publicKey)
    }

    /** Pushes a chart manifest at the release version; answers its digest. */
    public static PushChart(world: ReleaseWorld, version: string, content: string = 'chart'): string
    {
        return world.Registry.PutManifest(Schema3Fixture.ChartRepo, version, new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, content })), Schema3Fixture.ChartManifestType)
    }
}

describe('release descriptor schema 3', () =>
{
    it('schema 3 round-trips and binds the chart digest in the signature', () =>
    {
        const keys = Schema3Fixture.Keys()
        const descriptor = Schema3Fixture.Descriptor(3, keys.Private)
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const decoded = ReleaseDescriptorCodec.Decode(bytes)
        assert.deepEqual(decoded, descriptor)
        assert.deepEqual(ReleaseDescriptorCodec.ChartOf(decoded), descriptor.chart)
        const signature = ReleaseSignature.Sign(OciRegistryClient.DigestOf(bytes), keys.Private)
        assert.ok(Schema3Fixture.Verifies(bytes, signature, keys.Public))
    })

    it('a tampered chart digest fails verification', () =>
    {
        const keys = Schema3Fixture.Keys()
        const descriptor = Schema3Fixture.Descriptor(3, keys.Private)
        const signature = ReleaseSignature.Sign(OciRegistryClient.DigestOf(ReleaseDescriptorCodec.Encode(descriptor)), keys.Private)
        const tampered = { ...descriptor, chart: { ...descriptor.chart!, digest: Schema3Fixture.OtherDigest } }
        const bytes = ReleaseDescriptorCodec.Encode(tampered)
        assert.doesNotThrow(() => ReleaseDescriptorCodec.Decode(bytes))
        assert.equal(Schema3Fixture.Verifies(bytes, signature, keys.Public), false)
    })

    it('schema 2 releases still verify, and carry no chart', () =>
    {
        const keys = Schema3Fixture.Keys()
        const descriptor = Schema3Fixture.Descriptor(2, keys.Private)
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const signature = ReleaseSignature.Sign(OciRegistryClient.DigestOf(bytes), keys.Private)
        const decoded = ReleaseDescriptorCodec.Decode(bytes)
        assert.equal(decoded.schema, 2)
        assert.equal(ReleaseDescriptorCodec.ChartOf(decoded), undefined)
        assert.ok(Schema3Fixture.Verifies(bytes, signature, keys.Public))
    })

    it('refuses a schema 3 without a chart, a chart of another version, and a chart on schema 2', () =>
    {
        const keys = Schema3Fixture.Keys()
        const three = Schema3Fixture.Descriptor(3, keys.Private)
        const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
        assert.throws(() => ReleaseDescriptorCodec.Decode(encode({ ...three, chart: undefined })), ReleaseDescriptorInvalidError)
        assert.throws(() => ReleaseDescriptorCodec.Decode(encode({ ...three, chart: { ...three.chart, version: '0.1.0-early.15' } })), /chart must name/)
        assert.throws(() => ReleaseDescriptorCodec.Decode(encode({ ...three, chart: { ...three.chart, digest: 'sha256:short' } })), /chart must name/)
        assert.throws(() => ReleaseDescriptorCodec.Decode(encode({ ...Schema3Fixture.Descriptor(2, keys.Private), chart: three.chart })), /only a schema-3 descriptor carries a chart/)
    })
})

describe('ReleasePublisher with the engine chart', () =>
{
    class Publishing
    {
        public readonly World = new ReleaseWorld()
        public readonly Keys = Schema3Fixture.Keys()

        public Publisher(): ReleasePublisher
        {
            return new ReleasePublisher(this.World.Client(), ReleaseWorld.Namespace, () => new Date('2026-11-24T00:00:00.000Z'))
        }

        public Input(chartDigest?: string)
        {
            return {
                Manifest: ReleaseManifest.Parse(this.World.ManifestText()),
                Assets: this.World.Assets,
                ReleaseCommit: Schema3Fixture.Commit,
                SigningKeyId: Schema3Fixture.KeyId,
                PrivateKeyPem: this.Keys.Private,
                TrustedPublicKeyPem: this.Keys.Public,
                ChartDigest: chartDigest,
            }
        }
    }

    it('publishes schema 3 binding the chart the registry holds at the release version', async () =>
    {
        const f = new Publishing()
        const digest = Schema3Fixture.PushChart(f.World, ReleaseWorld.ReleaseVersion)
        const { descriptor } = await f.Publisher().PublishManifest(f.Input(digest))
        assert.equal(descriptor.schema, 3)
        const host = new URL(f.World.Registry.Origin).host
        assert.deepEqual(descriptor.chart, { reference: host + '/pragmatic-tech-ai/charts/pragmatic-engine', version: ReleaseWorld.ReleaseVersion, digest })
        assert.equal(ReleaseDescriptorCodec.ChartReferenceOf('ghcr.io', 'pragmatic-tech-ai'), ReleaseDescriptorCodec.ChartReference)
    })

    it('refuses a chart digest the registry does not hold, publishing nothing', async () =>
    {
        const f = new Publishing()
        Schema3Fixture.PushChart(f.World, ReleaseWorld.ReleaseVersion)
        await assert.rejects(f.Publisher().PublishManifest(f.Input(Schema3Fixture.OtherDigest)), ReleaseChartMismatchError)
        const missing = new Publishing()
        await assert.rejects(missing.Publisher().PublishManifest(missing.Input(Schema3Fixture.Digest)), ReleaseChartMismatchError)
        assert.ok(missing.World.Registry.Requests.every(r => r.method === 'HEAD' || r.method === 'GET'))
    })

    it('without a chart digest still publishes schema 2', async () =>
    {
        const f = new Publishing()
        const { descriptor } = await f.Publisher().PublishManifest(f.Input())
        assert.equal(descriptor.schema, 2)
        assert.equal(descriptor.chart, undefined)
    })
})
