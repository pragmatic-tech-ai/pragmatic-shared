import { OciRegistryClient } from '../../oci-registry-client.js'
import { FakeOciRegistry } from '../../tests/fake-oci-registry.js'
import { FakeImageLayout, FakeReleaseImage } from '../../tests/fake-release-image.js'
import type { IComponentAssetSource } from '../component-asset-source.js'
import { ReleaseManifest } from '../release-manifest.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'

/** IComponentAssetSource over two maps: `<repository>@<version>` to the component.json bytes and to the tag's commit. */
export class FakeComponentAssets implements IComponentAssetSource
{
    private static readonly KeySeparator = '@'

    public readonly Assets = new Map<string, Uint8Array>()
    public readonly Commits = new Map<string, string>()
    public readonly CommitQueries: string[] = []

    public static KeyOf(repository: string, version: string): string
    {
        return repository + FakeComponentAssets.KeySeparator + version
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        return this.Assets.get(FakeComponentAssets.KeyOf(repository, version))
    }

    public async ReleaseCommit(repository: string, version: string): Promise<string | undefined>
    {
        const key = FakeComponentAssets.KeyOf(repository, version)
        this.CommitQueries.push(key)
        return this.Commits.get(key)
    }
}

/**
 * A platform release's world in memory: nine container repositories, each released at `v0.1.0` with a component.json
 * asset and a commit, and each image in a FakeOciRegistry labelled with that asset's digest; plus the manifest naming them.
 */
export class ReleaseWorld
{
    public static readonly Namespace = 'pragmatic-tech-ai'
    public static readonly Owner = 'pragmatic-tech-ai'
    public static readonly ReleaseVersion = '0.1.0-early.6'
    public static readonly ComponentVersion = '0.1.0'
    public static readonly ManifestSchema = 1
    public static readonly ImagePrefix = 'image '
    private static readonly PathSeparator = '/'
    private static readonly HexDigits = '0123456789abcdef'
    private static readonly CommitLength = 40
    /** The platform images are multi-arch indexes; the rest single image manifests (as the container releases push them). */
    public static readonly IndexApps: readonly ReleaseApp[] = [ReleaseApp.PlatformAdmin, ReleaseApp.PlatformEdge, ReleaseApp.TenantIdp, ReleaseApp.Postgres]

    public readonly Registry = new FakeOciRegistry()
    public readonly Images = new FakeReleaseImage(this.Registry)
    public readonly Assets = new FakeComponentAssets()
    public readonly Digests = new Map<ReleaseApp, string>()
    public readonly ComponentDigests = new Map<ReleaseApp, string>()

    /** Seeds every app (but `skip`): asset, commit and an image labelled with the asset's digest. */
    public constructor(skip?: ReleaseApp)
    {
        for (const app of ReleaseApps.All)
        {
            if (app === skip)
            {
                continue
            }
            const asset = ReleaseWorld.AssetOf(app, ReleaseWorld.ComponentVersion)
            const key = FakeComponentAssets.KeyOf(ReleaseWorld.Repository(app), ReleaseWorld.ComponentVersion)
            this.Assets.Assets.set(key, asset)
            this.Assets.Commits.set(key, ReleaseWorld.CommitOf(app))
            const label = OciRegistryClient.DigestOf(asset)
            this.ComponentDigests.set(app, label)
            this.Digests.set(app, this.PutImage(app, label))
        }
    }

    public static Repository(app: ReleaseApp): string
    {
        return ReleaseWorld.Owner + ReleaseWorld.PathSeparator + app
    }

    public static ImageRepo(app: ReleaseApp): string
    {
        return ReleaseWorld.Namespace + ReleaseWorld.PathSeparator + app
    }

    /** A component descriptor as a container release attaches it (`component`, `version`, then its content). */
    public static AssetOf(app: string, version: string): Uint8Array
    {
        return new TextEncoder().encode(JSON.stringify({ component: app, version, settings: [] }))
    }

    /** A stable 40-hex commit per app. */
    public static CommitOf(app: string): string
    {
        const digits = ReleaseWorld.HexDigits
        let commit = ''
        for (let i = 0; i < ReleaseWorld.CommitLength; i++)
        {
            commit += digits[(app.charCodeAt(i % app.length) + i) % digits.length]
        }
        return commit
    }

    /**
     * Stores the app's image as its container release pushes it, under `0.1.0` and `git-<commit>`, labelled `label`
     * (null: none); returns its digest.
     */
    public PutImage(app: ReleaseApp, label: string | null, content: string = ReleaseWorld.ImagePrefix + app): string
    {
        const layout = ReleaseWorld.IndexApps.includes(app) ? FakeImageLayout.Index : FakeImageLayout.Single
        const repo = ReleaseWorld.ImageRepo(app)
        this.Images.Put(repo, ReleaseManifest.CommitTagOf(ReleaseWorld.CommitOf(app)), content, layout, label)
        return this.Images.Put(repo, ReleaseWorld.ComponentVersion, content, layout, label)
    }

    public Client(): OciRegistryClient
    {
        return new OciRegistryClient(this.Registry.Origin, this.Registry.Fetch)
    }

    /** The manifest document as JSON: every seeded app at its digest (an app with no image gets a well-formed unknown digest). */
    public ManifestObject(): { schema: number; version: string; components: Record<string, Record<string, string>> }
    {
        const components: Record<string, Record<string, string>> = {}
        for (const app of ReleaseApps.All)
        {
            components[app] = {
                repository: ReleaseWorld.Repository(app),
                version: ReleaseWorld.ComponentVersion,
                digest: this.Digests.get(app) ?? FakeOciRegistry.DigestOf(new TextEncoder().encode(app)),
            }
        }
        return { schema: ReleaseWorld.ManifestSchema, version: ReleaseWorld.ReleaseVersion, components }
    }

    public ManifestText(): string
    {
        return JSON.stringify(this.ManifestObject())
    }
}
