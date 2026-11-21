import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OciArgumentError, OciProtocolError, OciRegistryClient } from '../oci-registry-client.js'
import { FakeOciRegistry } from './fake-oci-registry.js'
import { FakeImageLayout, FakeReleaseImage } from './fake-release-image.js'

class TagFixture
{
    public static readonly Repo = 'pragmatic-tech-ai/pragmatic-env-server'
    public static readonly ContainerTag = '0.1.0'
    public static readonly ReleaseTag = '0.1.0-early.6'
    public static readonly Content = 'image env-server'
    public static readonly MethodPut = 'PUT'
    public static readonly ContentType = 'Content-Type'

    public readonly Registry = new FakeOciRegistry()
    public readonly Images = new FakeReleaseImage(this.Registry)

    public constructor()
    {
        this.Registry.EnforceManifestAccept(true)
    }

    public Client(): OciRegistryClient
    {
        return new OciRegistryClient(this.Registry.Origin, this.Registry.Fetch)
    }

    public Put(layout: FakeImageLayout): string
    {
        return this.Images.Put(TagFixture.Repo, TagFixture.ContainerTag, TagFixture.Content, layout, FakeReleaseImage.ComponentDigestOf(TagFixture.Repo))
    }

    public get Puts(): Array<{ url: string; headers: Record<string, string> }>
    {
        return this.Registry.Requests.filter(r => r.method === TagFixture.MethodPut)
    }
}

describe('OciRegistryClient.TagManifest', () =>
{
    it('names an image manifest by one more tag with its own media type: the tag resolves to exactly the digest', async () =>
    {
        const f = new TagFixture()
        const digest = f.Put(FakeImageLayout.Single)
        const client = f.Client()
        await client.TagManifest(TagFixture.Repo, digest, TagFixture.ReleaseTag)
        assert.equal(await client.HeadManifest(TagFixture.Repo, TagFixture.ReleaseTag), digest)
        assert.equal(f.Puts.length, 1)
        assert.ok(f.Puts[0].url.endsWith('/manifests/' + TagFixture.ReleaseTag))
        assert.equal(f.Puts[0].headers[TagFixture.ContentType], FakeReleaseImage.ManifestType)
    })

    it('re-tags a multi-arch index as an index', async () =>
    {
        const f = new TagFixture()
        const digest = f.Put(FakeImageLayout.Index)
        const client = f.Client()
        await client.TagManifest(TagFixture.Repo, digest, TagFixture.ReleaseTag)
        assert.equal(await client.HeadManifest(TagFixture.Repo, TagFixture.ReleaseTag), digest)
        assert.equal(f.Puts[0].headers[TagFixture.ContentType], FakeReleaseImage.IndexType)
    })

    it('refuses a digest that is not sha256:<64 hex> and a tag that is not a reference, before any request', async () =>
    {
        const f = new TagFixture()
        const digest = f.Put(FakeImageLayout.Single)
        const client = f.Client()
        const before = f.Registry.Requests.length
        await assert.rejects(client.TagManifest(TagFixture.Repo, TagFixture.ContainerTag, TagFixture.ReleaseTag), OciArgumentError)
        await assert.rejects(client.TagManifest(TagFixture.Repo, digest, 'bad tag/with spaces'), OciArgumentError)
        assert.equal(f.Registry.Requests.length, before)
    })

    it('refuses manifest bytes that do not hash to the digest they were pulled by, and pushes nothing', async () =>
    {
        const f = new TagFixture()
        const digest = f.Put(FakeImageLayout.Single)
        const other = f.Images.ManifestBytes(TagFixture.Repo, 'something else', null)
        f.Registry.PutManifest(TagFixture.Repo, digest, other, FakeReleaseImage.ManifestType)
        await assert.rejects(f.Client().TagManifest(TagFixture.Repo, digest, TagFixture.ReleaseTag), OciProtocolError)
        assert.equal(f.Puts.length, 0)
    })

    it('refuses a manifest whose declared media type the client does not read', async () =>
    {
        const f = new TagFixture()
        const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: 'application/x-unknown', layers: [] }))
        const digest = f.Registry.PutManifest(TagFixture.Repo, TagFixture.ContainerTag, bytes, FakeReleaseImage.ManifestType)
        await assert.rejects(f.Client().TagManifest(TagFixture.Repo, digest, TagFixture.ReleaseTag), OciProtocolError)
        assert.equal(f.Puts.length, 0)
    })

    it('PushManifest sends the given media type, an OCI image manifest by default', async () =>
    {
        const f = new TagFixture()
        const bytes = new TextEncoder().encode('{}')
        const client = f.Client()
        await client.PushManifest(TagFixture.Repo, 'a', bytes)
        await client.PushManifest(TagFixture.Repo, 'b', bytes, FakeReleaseImage.IndexType)
        assert.deepEqual(f.Puts.map(p => p.headers[TagFixture.ContentType]), [FakeReleaseImage.ManifestType, FakeReleaseImage.IndexType])
    })
})
