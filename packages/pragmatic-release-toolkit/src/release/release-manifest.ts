import { OciRegistryClient } from '../oci-registry-client.js'
import type { IComponentAssetSource } from './component-asset-source.js'
import { ComponentImageLabel, ComponentLabelError } from './component-image-label.js'
import { ReleaseDescriptorCodec } from './release-descriptor.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseApp, ReleaseApps, ReleaseTag, ReleaseTagInvalidError } from './release-tag.js'

/** One app of a platform release: the container repository that released it, that release's version and the image digest. */
export type ReleaseManifestComponent = {
    /** `<owner>/<name>` of the container repository (GitHub). */
    readonly repository: string
    /** The container repository's release version (its tag is `v<version>`). */
    readonly version: string
    /** The image manifest (or index) digest in `ghcr.io/<namespace>/<app>`. */
    readonly digest: string
}

/** `release.json` of pragmatic-platform-release: the platform release version and every app's image, by digest. */
export type ReleaseManifestDocument = {
    readonly schema: 1
    readonly version: string
    readonly components: Readonly<Record<ReleaseApp, ReleaseManifestComponent>>
}

/** The manifest is not a release manifest. The reason is a fixed sentence plus at most an app name or field name. */
export class ReleaseManifestInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseManifestInvalidError'
    private static readonly MessagePrefix = 'Invalid release manifest: '

    public constructor(public readonly Reason: string)
    {
        super(ReleaseManifestInvalidError.MessagePrefix + Reason)
        this.name = ReleaseManifestInvalidError.ErrorName
    }
}

/** An app of ReleaseApps.All has no component: every release ships all of them. */
export class ReleaseManifestMissingAppError extends ReleaseManifestInvalidError
{
    private static readonly TypeName = 'ReleaseManifestMissingAppError'
    private static readonly ReasonPrefix = 'missing app: '

    public constructor(public readonly App: ReleaseApp)
    {
        super(ReleaseManifestMissingAppError.ReasonPrefix + App)
        this.name = ReleaseManifestMissingAppError.TypeName
    }
}

/** A component names no release app. The name is echoed only when it has a plain name shape. */
export class ReleaseManifestUnknownAppError extends ReleaseManifestInvalidError
{
    private static readonly TypeName = 'ReleaseManifestUnknownAppError'
    private static readonly Reason = 'unknown app'
    private static readonly NameSeparator = ': '

    public constructor(public readonly Name: string)
    {
        super(ReleaseDescriptorCodec.IsRepoName(Name)
            ? ReleaseManifestUnknownAppError.Reason + ReleaseManifestUnknownAppError.NameSeparator + Name
            : ReleaseManifestUnknownAppError.Reason)
        this.name = ReleaseManifestUnknownAppError.TypeName
    }
}

/** A component's image reference is not a `sha256:<64 hex>` digest (a tag, a placeholder, ...). */
export class ReleaseManifestDigestError extends ReleaseManifestInvalidError
{
    private static readonly TypeName = 'ReleaseManifestDigestError'
    private static readonly ReasonPrefix = 'not a sha256 digest: '

    public constructor(public readonly App: ReleaseApp)
    {
        super(ReleaseManifestDigestError.ReasonPrefix + App)
        this.name = ReleaseManifestDigestError.TypeName
    }
}

/** What Check found wrong with one app: one fixed sentence each. */
export enum ReleaseManifestProblemKind
{
    ImageMissing = 'the image is not in the registry at the manifest digest',
    LabelMissing = 'the image carries no component descriptor label',
    LabelUnreadable = 'the image component descriptor label cannot be read',
    VersionTagTaken = 'the image repository already tags release-<version> with another digest',
    AssetMissing = 'the repository release v<version> has no component.json asset',
    AssetMismatch = 'the image component label is not the digest of the component.json asset',
    AssetForeign = 'the component.json asset is not this app at the manifest version',
    CommitMissing = 'the repository has no tag v<version>',
    CommitForeign = 'the image tags <version> and git-<commit of v<version>> do not both name the manifest digest',
}

export type ReleaseManifestProblem = { readonly App: ReleaseApp; readonly Kind: ReleaseManifestProblemKind }

/** Check's findings plus what a clean manifest gives the descriptor: each app's component digest and each repository's commit. */
export type ReleaseManifestInspection = {
    readonly Problems: readonly ReleaseManifestProblem[]
    /** The component descriptor digest each app's image is labelled with (apps whose label was read). */
    readonly ComponentDigests: ReadonlyMap<ReleaseApp, string>
    /** The commit of `v<version>` per repository name (the part after the owner), for the repositories that have the tag. */
    readonly Commits: ReadonlyMap<string, string>
}

/**
 * The platform release manifest: parsed strictly (`Parse`: schema 1, a release version, all nine apps and nothing else,
 * each a repository, a version and a digest) and checked against what the registry and the container repositories'
 * releases hold (`Check`): each image exists at its digest, carries a component label, and that label is the digest of
 * the `component.json` the repository's release `v<version>` attached (whose `component` and `version` are the app's);
 * the image tag `release-<version>` (ImageTagOf) is free on every image repository or already names the same digest
 * (a re-run after a partial publish); the repository tag `v<version>` exists and its commit is the one the image was
 * released from (the image's `<version>` and `git-<commit>` tags both name the manifest digest).
 * Imports only node builtins and builtin-only relative modules.
 */
export class ReleaseManifest
{
    public static readonly Schema = 1
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly VersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
    private static readonly RepositorySeparator = '/'
    private static readonly FieldSchema = 'schema'
    private static readonly FieldVersion = 'version'
    private static readonly FieldComponents = 'components'
    private static readonly FieldRepository = 'repository'
    private static readonly FieldDigest = 'digest'
    private static readonly FieldComponent = 'component'
    private static readonly TopFields: ReadonlySet<string> = new Set([ReleaseManifest.FieldSchema, ReleaseManifest.FieldVersion, ReleaseManifest.FieldComponents])
    private static readonly ComponentFields: ReadonlySet<string> = new Set([ReleaseManifest.FieldRepository, ReleaseManifest.FieldVersion, ReleaseManifest.FieldDigest])
    private static readonly NotJson = 'not valid JSON'
    private static readonly NotObject = 'not an object'
    private static readonly BadSchema = 'schema must be 1'
    private static readonly BadVersion = 'version is not a release version (X.Y.Z or X.Y.Z-early.N)'
    private static readonly BadComponents = 'components must be an object of apps'
    private static readonly UnknownField = 'unknown field'
    private static readonly FieldSeparator = ': '
    /** The image tag a platform release adds: prefixed, so it never meets a container release's `<version>` tag. */
    private static readonly ImageTagPrefix = 'release-'
    /** The tag a container release gives its image beside `<version>` (container-release.yml). */
    private static readonly CommitTagPrefix = 'git-'
    private static readonly BadComponentPrefix = 'ill-shaped component: '
    private static readonly BadRepositoryPrefix = 'repository is not '
    private static readonly BadComponentVersionPrefix = 'version is not X.Y.Z[-pre-release]: '
    private static readonly ProblemSeparator = ': '

    /**
     * Parses `release.json`; throws a ReleaseManifestInvalidError (or one of its subclasses) for anything but a full manifest
     * whose every app comes from its own container repository, `<namespace>/<app>` (the repository its image is named
     * after, so no release is assembled from a fork's or another app's release).
     */
    public static Parse(text: string, namespace: string = ReleaseRegistry.DefaultNamespace): ReleaseManifestDocument
    {
        const S = ReleaseManifest
        let raw: unknown
        try
        {
            raw = JSON.parse(text)
        }
        catch
        {
            throw new ReleaseManifestInvalidError(S.NotJson)
        }
        if (!S.IsRecord(raw))
        {
            throw new ReleaseManifestInvalidError(S.NotObject)
        }
        S.RefuseUnknownFields(raw, S.TopFields)
        if (raw.schema !== S.Schema)
        {
            throw new ReleaseManifestInvalidError(S.BadSchema)
        }
        if (typeof raw.version !== 'string' || !S.IsReleaseVersion(raw.version))
        {
            throw new ReleaseManifestInvalidError(S.BadVersion)
        }
        if (!S.IsRecord(raw.components))
        {
            throw new ReleaseManifestInvalidError(S.BadComponents)
        }
        for (const name of Object.keys(raw.components))
        {
            if (!ReleaseApps.All.includes(name as ReleaseApp))
            {
                throw new ReleaseManifestUnknownAppError(name)
            }
        }
        const components: Partial<Record<ReleaseApp, ReleaseManifestComponent>> = {}
        for (const app of ReleaseApps.All)
        {
            components[app] = S.ParseComponent(app, raw.components[app], namespace)
        }
        return { schema: S.Schema, version: raw.version, components: components as Record<ReleaseApp, ReleaseManifestComponent> }
    }

    /**
     * The tag a platform release gives each of its images, `release-<version>`: a container repository's release tags its
     * image `<version>` (and `git-<sha>`), so the two never meet in one image repository.
     */
    public static ImageTagOf(releaseVersion: string): string
    {
        return ReleaseManifest.ImageTagPrefix + releaseVersion
    }

    /** The tag a container release gives its image beside `<version>`: `git-<commit>` (container-release.yml). */
    public static CommitTagOf(commit: string): string
    {
        return ReleaseManifest.CommitTagPrefix + commit
    }

    /** The repository's name without its owner: the key of the release descriptor's `siblingCommits`. */
    public static RepositoryName(repository: string): string
    {
        return repository.slice(repository.indexOf(ReleaseManifest.RepositorySeparator) + 1)
    }

    /** Every problem with the manifest's apps, in ReleaseApps.All order; empty when a release can be assembled from it. */
    public static async Check(doc: ReleaseManifestDocument, registry: OciRegistryClient, assets: IComponentAssetSource,
        namespace: string = ReleaseRegistry.DefaultNamespace): Promise<readonly ReleaseManifestProblem[]>
    {
        return (await ReleaseManifest.Inspect(doc, registry, assets, namespace)).Problems
    }

    /** Check, keeping what the release descriptor needs from a clean manifest. Registry and GitHub failures throw. */
    public static async Inspect(doc: ReleaseManifestDocument, registry: OciRegistryClient, assets: IComponentAssetSource,
        namespace: string = ReleaseRegistry.DefaultNamespace): Promise<ReleaseManifestInspection>
    {
        const S = ReleaseManifest
        const problems: ReleaseManifestProblem[] = []
        const componentDigests = new Map<ReleaseApp, string>()
        const commits = new Map<string, string>()
        for (const app of ReleaseApps.All)
        {
            const component = doc.components[app]
            const kinds = await S.CheckImage(app, component, doc.version, registry, ReleaseRegistry.RepositoryPath(namespace, app), assets, componentDigests)
            const commit = await assets.ReleaseCommit(component.repository, component.version)
            if (commit !== undefined)
            {
                commits.set(S.RepositoryName(component.repository), commit)
            }
            if (commit === undefined)
            {
                kinds.push(ReleaseManifestProblemKind.CommitMissing)
            }
            else if (!kinds.includes(ReleaseManifestProblemKind.ImageMissing)
                && !await S.ImageIsOf(registry, ReleaseRegistry.RepositoryPath(namespace, app), component, commit))
            {
                kinds.push(ReleaseManifestProblemKind.CommitForeign)
            }
            problems.push(...kinds.map(kind => ({ App: app, Kind: kind })))
        }
        return { Problems: problems, ComponentDigests: componentDigests, Commits: commits }
    }

    /**
     * The image is the one the repository's release `v<version>` pushed from `commit`: container-release.yml tags it
     * `<version>` and `git-<commit>`, and both must still name the manifest digest (a moved tag, a re-pushed image or
     * a digest from another build fails), so the signed `siblingCommits` describe the images they sit beside.
     */
    private static async ImageIsOf(registry: OciRegistryClient, repo: string, component: ReleaseManifestComponent, commit: string): Promise<boolean>
    {
        const S = ReleaseManifest
        return await registry.HeadManifest(repo, component.version) === component.digest
            && await registry.HeadManifest(repo, S.CommitTagOf(commit)) === component.digest
    }

    /** `<app>: <sentence>`. */
    public static Describe(problem: ReleaseManifestProblem): string
    {
        return problem.App + ReleaseManifest.ProblemSeparator + problem.Kind
    }

    private static async CheckImage(app: ReleaseApp, component: ReleaseManifestComponent, releaseVersion: string, registry: OciRegistryClient,
        repo: string, assets: IComponentAssetSource, componentDigests: Map<ReleaseApp, string>): Promise<ReleaseManifestProblemKind[]>
    {
        const S = ReleaseManifest
        const kinds: ReleaseManifestProblemKind[] = []
        if (await registry.HeadManifest(repo, component.digest) !== component.digest)
        {
            kinds.push(ReleaseManifestProblemKind.ImageMissing)
        }
        let label: string | undefined
        if (kinds.length === 0)
        {
            try
            {
                label = await ComponentImageLabel.Read(registry, repo, component.digest)
                if (label === undefined)
                {
                    kinds.push(ReleaseManifestProblemKind.LabelMissing)
                }
                else
                {
                    componentDigests.set(app, label)
                }
            }
            catch (error)
            {
                if (!(error instanceof ComponentLabelError))
                {
                    throw error
                }
                kinds.push(ReleaseManifestProblemKind.LabelUnreadable)
            }
            const tagged = await registry.HeadManifest(repo, S.ImageTagOf(releaseVersion))
            if (tagged !== undefined && tagged !== component.digest)
            {
                kinds.push(ReleaseManifestProblemKind.VersionTagTaken)
            }
        }
        const asset = await assets.ComponentAsset(component.repository, component.version)
        if (asset === undefined)
        {
            kinds.push(ReleaseManifestProblemKind.AssetMissing)
            return kinds
        }
        if (!S.AssetIs(asset, app, component.version))
        {
            kinds.push(ReleaseManifestProblemKind.AssetForeign)
        }
        if (label !== undefined && OciRegistryClient.DigestOf(asset) !== label)
        {
            kinds.push(ReleaseManifestProblemKind.AssetMismatch)
        }
        return kinds
    }

    /** The asset is a component descriptor of `app` at `version` (its `component` and `version` fields). */
    private static AssetIs(asset: Uint8Array, app: ReleaseApp, version: string): boolean
    {
        const S = ReleaseManifest
        let parsed: unknown
        try
        {
            parsed = JSON.parse(new TextDecoder().decode(asset))
        }
        catch
        {
            return false
        }
        return S.IsRecord(parsed) && parsed[S.FieldComponent] === app && parsed[S.FieldVersion] === version
    }

    private static ParseComponent(app: ReleaseApp, value: unknown, namespace: string): ReleaseManifestComponent
    {
        const S = ReleaseManifest
        if (value === undefined)
        {
            throw new ReleaseManifestMissingAppError(app)
        }
        if (!S.IsRecord(value)
            || typeof value.repository !== 'string'
            || typeof value.version !== 'string'
            || typeof value.digest !== 'string')
        {
            throw new ReleaseManifestInvalidError(S.BadComponentPrefix + app)
        }
        S.RefuseUnknownFields(value, S.ComponentFields)
        if (value.repository !== S.RepositoryOf(namespace, app))
        {
            throw new ReleaseManifestInvalidError(S.BadRepositoryPrefix + S.RepositoryOf(namespace, app) + S.ProblemSeparator + app)
        }
        if (!S.VersionPattern.test(value.version))
        {
            throw new ReleaseManifestInvalidError(S.BadComponentVersionPrefix + app)
        }
        if (!S.DigestPattern.test(value.digest))
        {
            throw new ReleaseManifestDigestError(app)
        }
        return { repository: value.repository, version: value.version, digest: value.digest }
    }

    private static RefuseUnknownFields(value: Record<string, unknown>, known: ReadonlySet<string>): void
    {
        for (const key of Object.keys(value))
        {
            if (!known.has(key))
            {
                throw new ReleaseManifestInvalidError(ReleaseDescriptorCodec.IsRepoName(key)
                    ? ReleaseManifest.UnknownField + ReleaseManifest.FieldSeparator + key
                    : ReleaseManifest.UnknownField)
            }
        }
    }

    /** `<namespace>/<app>`: the container repository an app's image and component.json come from. */
    private static RepositoryOf(namespace: string, app: ReleaseApp): string
    {
        return namespace + ReleaseManifest.RepositorySeparator + app
    }

    private static IsReleaseVersion(version: string): boolean
    {
        try
        {
            ReleaseTag.FromVersion(version)
            return true
        }
        catch (error)
        {
            if (error instanceof ReleaseTagInvalidError)
            {
                return false
            }
            throw error
        }
    }

    private static IsRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
