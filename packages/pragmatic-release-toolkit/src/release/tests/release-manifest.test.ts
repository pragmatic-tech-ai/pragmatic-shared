import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OciRegistryClient } from '../../oci-registry-client.js'
import { FakeReleaseImage } from '../../tests/fake-release-image.js'
import {
    ReleaseManifest,
    ReleaseManifestDigestError,
    ReleaseManifestInvalidError,
    ReleaseManifestMissingAppError,
    ReleaseManifestProblemKind,
    ReleaseManifestUnknownAppError,
} from '../release-manifest.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'
import { FakeComponentAssets, ReleaseWorld } from './release-manifest-fixture.js'

class Edit
{
    public static readonly Tag = 'latest'
    public static readonly Placeholder = 'sha256:<filled after the v0.1.0 tags>'
    public static readonly Stranger = 'pragmatic-stranger'
    public static readonly BadName = '../evil'
    public static readonly OtherVersion = '0.2.0'
    public static readonly OtherOwner = 'someone-else'

    /** The world's manifest text after `change` edits the parsed object. */
    public static Text(world: ReleaseWorld, change: (doc: ReturnType<ReleaseWorld['ManifestObject']>) => void): string
    {
        const doc = world.ManifestObject()
        change(doc)
        return JSON.stringify(doc)
    }
}

describe('ReleaseManifest.Parse', () =>
{
    it('parses a nine-app manifest', () =>
    {
        const world = new ReleaseWorld()
        const doc = ReleaseManifest.Parse(world.ManifestText())
        assert.equal(doc.schema, 1)
        assert.equal(doc.version, ReleaseWorld.ReleaseVersion)
        assert.deepEqual(Object.keys(doc.components).sort(), [...ReleaseApps.All].sort())
        assert.equal(ReleaseApps.All.length, 9)
        for (const app of ReleaseApps.All)
        {
            assert.deepEqual(doc.components[app], {
                repository: ReleaseWorld.Repository(app),
                version: ReleaseWorld.ComponentVersion,
                digest: world.Digests.get(app),
            })
        }
    })

    it('refuses a missing app, naming it', () =>
    {
        const text = Edit.Text(new ReleaseWorld(), doc => { delete doc.components[ReleaseApp.Postgres] })
        assert.throws(() => ReleaseManifest.Parse(text), (error: unknown) =>
            error instanceof ReleaseManifestMissingAppError && error.App === ReleaseApp.Postgres && error.message.includes(ReleaseApp.Postgres))
    })

    it('refuses an unknown app, echoing its name only when it has a plain name shape', () =>
    {
        const world = new ReleaseWorld()
        const plain = Edit.Text(world, doc => { doc.components[Edit.Stranger] = doc.components[ReleaseApp.UiUnpack] })
        assert.throws(() => ReleaseManifest.Parse(plain), (error: unknown) =>
            error instanceof ReleaseManifestUnknownAppError && error.message.includes(Edit.Stranger))
        const odd = Edit.Text(world, doc => { doc.components[Edit.BadName] = doc.components[ReleaseApp.UiUnpack] })
        assert.throws(() => ReleaseManifest.Parse(odd), (error: unknown) =>
            error instanceof ReleaseManifestUnknownAppError && !error.message.includes(Edit.BadName))
    })

    it('refuses a non-digest reference: a tag, a placeholder, a short or upper-case digest', () =>
    {
        const world = new ReleaseWorld()
        const digest = world.Digests.get(ReleaseApp.EnvServer) as string
        for (const reference of [Edit.Tag, Edit.Placeholder, digest.slice(0, -1), digest.toUpperCase()])
        {
            const text = Edit.Text(world, doc => { doc.components[ReleaseApp.EnvServer].digest = reference })
            assert.throws(() => ReleaseManifest.Parse(text), (error: unknown) =>
                error instanceof ReleaseManifestDigestError && error.App === ReleaseApp.EnvServer, reference)
        }
    })

    it('refuses anything but schema 1, a release version, known fields and well-shaped components', () =>
    {
        const world = new ReleaseWorld()
        const bad: string[] = [
            'not json',
            '[]',
            Edit.Text(world, doc => { doc.schema = 2 }),
            Edit.Text(world, doc => { doc.version = '0.1' }),
            Edit.Text(world, doc => { doc.version = '0.1.0-beta.1' }),
            Edit.Text(world, doc => { (doc as Record<string, unknown>).extra = true }),
            Edit.Text(world, doc => { (doc as Record<string, unknown>).components = [] }),
            Edit.Text(world, doc => { doc.components[ReleaseApp.EnvGateway].extra = 'x' }),
            Edit.Text(world, doc => { delete doc.components[ReleaseApp.EnvGateway].repository }),
            Edit.Text(world, doc => { doc.components[ReleaseApp.EnvGateway].repository = 'no-owner' }),
            Edit.Text(world, doc => { doc.components[ReleaseApp.EnvGateway].repository = 'a/b/c' }),
            Edit.Text(world, doc => { doc.components[ReleaseApp.EnvGateway].version = 'v0.1.0' }),
        ]
        for (const text of bad)
        {
            assert.throws(() => ReleaseManifest.Parse(text), ReleaseManifestInvalidError, text)
        }
    })

    it('refuses two apps naming one repository at different owners or versions (one commit per repository name)', () =>
    {
        const world = new ReleaseWorld()
        const shared = (change: (component: Record<string, string>) => void): string => Edit.Text(world, doc =>
        {
            doc.components[ReleaseApp.EnvGateway].repository = doc.components[ReleaseApp.EnvServer].repository
            change(doc.components[ReleaseApp.EnvGateway])
        })
        assert.doesNotThrow(() => ReleaseManifest.Parse(shared(() => undefined)))
        assert.throws(() => ReleaseManifest.Parse(shared(component => { component.version = Edit.OtherVersion })), ReleaseManifestInvalidError)
        assert.throws(() => ReleaseManifest.Parse(shared(component =>
        {
            component.repository = Edit.OtherOwner + '/' + ReleaseApp.EnvServer
        })), ReleaseManifestInvalidError)
    })

    it('names an unknown field only when it has a plain name shape', () =>
    {
        const world = new ReleaseWorld()
        const plain = Edit.Text(world, doc => { (doc as Record<string, unknown>).notes = 'x' })
        assert.throws(() => ReleaseManifest.Parse(plain), (error: unknown) => error instanceof ReleaseManifestInvalidError && error.Reason === 'unknown field: notes')
        const odd = Edit.Text(world, doc => { (doc as Record<string, unknown>)[Edit.BadName] = 'x' })
        assert.throws(() => ReleaseManifest.Parse(odd), (error: unknown) => error instanceof ReleaseManifestInvalidError && error.Reason === 'unknown field')
    })

    it('names a repository by the part after its owner', () =>
    {
        assert.equal(ReleaseManifest.RepositoryName(ReleaseWorld.Repository(ReleaseApp.HiveAgent)), ReleaseApp.HiveAgent)
    })
})

describe('ReleaseManifest.Check', () =>
{
    it('finds nothing wrong with a manifest whose images, labels, assets and tags agree, and keeps the component digests and commits', async () =>
    {
        const world = new ReleaseWorld()
        const doc = ReleaseManifest.Parse(world.ManifestText())
        const inspection = await ReleaseManifest.Inspect(doc, world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.deepEqual(inspection.Problems, [])
        assert.deepEqual([...inspection.ComponentDigests], ReleaseApps.All.map(app => [app, world.ComponentDigests.get(app)]))
        assert.deepEqual([...inspection.Commits], ReleaseApps.All.map(app => [app, ReleaseWorld.CommitOf(app)]))
        assert.deepEqual(await ReleaseManifest.Check(doc, world.Client(), world.Assets, ReleaseWorld.Namespace), [])
    })

    it('reports a label that does not match the component asset', async () =>
    {
        const world = new ReleaseWorld()
        const stale = FakeReleaseImage.ComponentDigestOf(ReleaseApp.TenantAdmin)
        world.Digests.set(ReleaseApp.TenantAdmin, world.PutImage(ReleaseApp.TenantAdmin, stale, ReleaseWorld.ImagePrefix + 'rebuilt'))
        const problems = await ReleaseManifest.Check(ReleaseManifest.Parse(world.ManifestText()), world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.deepEqual(problems, [{ App: ReleaseApp.TenantAdmin, Kind: ReleaseManifestProblemKind.AssetMismatch }])
        assert.equal(ReleaseManifest.Describe(problems[0]), ReleaseApp.TenantAdmin + ': ' + ReleaseManifestProblemKind.AssetMismatch)
    })

    it('reports an image absent at its digest, and still checks its asset and tag', async () =>
    {
        const world = new ReleaseWorld(ReleaseApp.EnvGateway)
        const key = FakeComponentAssets.KeyOf(ReleaseWorld.Repository(ReleaseApp.EnvGateway), ReleaseWorld.ComponentVersion)
        world.Assets.Assets.set(key, ReleaseWorld.AssetOf(ReleaseApp.EnvGateway, ReleaseWorld.ComponentVersion))
        world.Assets.Commits.set(key, ReleaseWorld.CommitOf(ReleaseApp.EnvGateway))
        const problems = await ReleaseManifest.Check(ReleaseManifest.Parse(world.ManifestText()), world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.deepEqual(problems, [{ App: ReleaseApp.EnvGateway, Kind: ReleaseManifestProblemKind.ImageMissing }])
    })

    it('reports an image with no component label', async () =>
    {
        const world = new ReleaseWorld()
        world.Digests.set(ReleaseApp.HiveAgent, world.PutImage(ReleaseApp.HiveAgent, null, ReleaseWorld.ImagePrefix + 'unlabelled'))
        const problems = await ReleaseManifest.Check(ReleaseManifest.Parse(world.ManifestText()), world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.deepEqual(problems, [{ App: ReleaseApp.HiveAgent, Kind: ReleaseManifestProblemKind.LabelMissing }])
    })

    it('reports a missing asset, a foreign asset and a missing release tag', async () =>
    {
        const world = new ReleaseWorld()
        const keyOf = (app: ReleaseApp): string => FakeComponentAssets.KeyOf(ReleaseWorld.Repository(app), ReleaseWorld.ComponentVersion)
        world.Assets.Assets.delete(keyOf(ReleaseApp.UiUnpack))
        const foreign = ReleaseWorld.AssetOf(ReleaseApp.EnvServer, ReleaseWorld.ComponentVersion)
        world.Assets.Assets.set(keyOf(ReleaseApp.TenantIdp), foreign)
        world.Digests.set(ReleaseApp.TenantIdp, world.PutImage(ReleaseApp.TenantIdp, OciRegistryClient.DigestOf(foreign), ReleaseWorld.ImagePrefix + 'foreign'))
        world.Assets.Commits.delete(keyOf(ReleaseApp.PlatformEdge))
        const problems = await ReleaseManifest.Check(ReleaseManifest.Parse(world.ManifestText()), world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.deepEqual(problems, [
            { App: ReleaseApp.PlatformEdge, Kind: ReleaseManifestProblemKind.CommitMissing },
            { App: ReleaseApp.TenantIdp, Kind: ReleaseManifestProblemKind.AssetForeign },
            { App: ReleaseApp.UiUnpack, Kind: ReleaseManifestProblemKind.AssetMissing },
        ])
    })

    it('reports release-<version> already tagged on an image repository with another digest; the same digest is fine', async () =>
    {
        const world = new ReleaseWorld()
        const client = world.Client()
        const repo = ReleaseWorld.ImageRepo(ReleaseApp.EnvServer)
        const own = world.Digests.get(ReleaseApp.EnvServer) as string
        const tag = ReleaseManifest.ImageTagOf(ReleaseWorld.ReleaseVersion)
        assert.equal(tag, 'release-' + ReleaseWorld.ReleaseVersion)
        await client.TagManifest(repo, own, tag)
        const doc = ReleaseManifest.Parse(world.ManifestText())
        assert.deepEqual(await ReleaseManifest.Check(doc, client, world.Assets, ReleaseWorld.Namespace), [])
        const other = world.Digests.get(ReleaseApp.EnvGateway) as string
        world.Registry.PutManifest(repo, tag, await client.PullManifest(ReleaseWorld.ImageRepo(ReleaseApp.EnvGateway), other), FakeReleaseImage.ManifestType)
        assert.deepEqual(await ReleaseManifest.Check(doc, client, world.Assets, ReleaseWorld.Namespace),
            [{ App: ReleaseApp.EnvServer, Kind: ReleaseManifestProblemKind.VersionTagTaken }])
    })

    it('reports an image its repository release tag does not describe: a moved v<version> tag, or a <version> tag on another image', async () =>
    {
        const moved = new ReleaseWorld()
        const key = FakeComponentAssets.KeyOf(ReleaseWorld.Repository(ReleaseApp.HiveAgent), ReleaseWorld.ComponentVersion)
        moved.Assets.Commits.set(key, 'f'.repeat(40))
        assert.deepEqual(await ReleaseManifest.Check(ReleaseManifest.Parse(moved.ManifestText()), moved.Client(), moved.Assets, ReleaseWorld.Namespace),
            [{ App: ReleaseApp.HiveAgent, Kind: ReleaseManifestProblemKind.CommitForeign }])

        const repushed = new ReleaseWorld()
        const doc = ReleaseManifest.Parse(repushed.ManifestText())
        repushed.PutImage(ReleaseApp.UiUnpack, repushed.ComponentDigests.get(ReleaseApp.UiUnpack) as string, ReleaseWorld.ImagePrefix + 'rebuilt')
        assert.deepEqual(await ReleaseManifest.Check(doc, repushed.Client(), repushed.Assets, ReleaseWorld.Namespace),
            [{ App: ReleaseApp.UiUnpack, Kind: ReleaseManifestProblemKind.CommitForeign }])
    })

    it('reports CommitForeign when only the <version> tag moved, and when the image has no git-<commit> tag', async () =>
    {
        const versionMoved = new ReleaseWorld()
        const doc = ReleaseManifest.Parse(versionMoved.ManifestText())
        const repo = ReleaseWorld.ImageRepo(ReleaseApp.EnvGateway)
        const client = versionMoved.Client()
        const other = await client.PullManifest(ReleaseWorld.ImageRepo(ReleaseApp.EnvServer), versionMoved.Digests.get(ReleaseApp.EnvServer) as string)
        versionMoved.Registry.PutManifest(repo, ReleaseWorld.ComponentVersion, other, FakeReleaseImage.ManifestType)
        assert.equal(await client.HeadManifest(repo, ReleaseManifest.CommitTagOf(ReleaseWorld.CommitOf(ReleaseApp.EnvGateway))), versionMoved.Digests.get(ReleaseApp.EnvGateway))
        assert.deepEqual(await ReleaseManifest.Check(doc, client, versionMoved.Assets, ReleaseWorld.Namespace),
            [{ App: ReleaseApp.EnvGateway, Kind: ReleaseManifestProblemKind.CommitForeign }])

        const noCommitTag = new ReleaseWorld()
        const key = FakeComponentAssets.KeyOf(ReleaseWorld.Repository(ReleaseApp.TenantIdp), ReleaseWorld.ComponentVersion)
        noCommitTag.Assets.Commits.set(key, 'e'.repeat(40))
        assert.equal(await noCommitTag.Client().HeadManifest(ReleaseWorld.ImageRepo(ReleaseApp.TenantIdp), ReleaseManifest.CommitTagOf('e'.repeat(40))), undefined)
        assert.deepEqual(await ReleaseManifest.Check(ReleaseManifest.Parse(noCommitTag.ManifestText()), noCommitTag.Client(), noCommitTag.Assets, ReleaseWorld.Namespace),
            [{ App: ReleaseApp.TenantIdp, Kind: ReleaseManifestProblemKind.CommitForeign }])
    })

    it('asks each repository for its release commit once, whichever apps share it', async () =>
    {
        const world = new ReleaseWorld()
        const doc = ReleaseManifest.Parse(world.ManifestText())
        await ReleaseManifest.Check(doc, world.Client(), world.Assets, ReleaseWorld.Namespace)
        assert.equal(world.Assets.CommitQueries.length, ReleaseApps.All.length)
        assert.equal(new Set(world.Assets.CommitQueries).size, ReleaseApps.All.length)
    })
})
