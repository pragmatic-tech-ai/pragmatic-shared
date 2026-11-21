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
    private static readonly ReasonPrefix = 'missing app: '

    public constructor(public readonly App: ReleaseApp)
    {
        super(ReleaseManifestMissingAppError.ReasonPrefix + App)
        this.name = ReleaseManifestMissingAppError.name
    }
}

/** A component names no release app. The name is echoed only when it has a plain name shape. */
export class ReleaseManifestUnknownAppError extends ReleaseManifestInvalidError
{
    private static readonly Reason = 'unknown app'
    private static readonly NameSeparator = ': '

    public constructor(public readonly Name: string)
    {
        super(ReleaseDescriptorCodec.IsRepoName(Name)
            ? ReleaseManifestUnknownAppError.Reason + ReleaseManifestUnknownAppError.NameSeparator + Name
            : ReleaseManifestUnknownAppError.Reason)
        this.name = ReleaseManifestUnknownAppError.name
    }
}

/** A component's image reference is not a `sha256:<64 hex>` digest (a tag, a placeholder, ...). */
export class ReleaseManifestDigestError extends ReleaseManifestInvalidError
{
    private static readonly ReasonPrefix = 'not a sha256 digest: '

    public constructor(public readonly App: ReleaseApp)
    {
        super(ReleaseManifestDigestError.ReasonPrefix + App)
        this.name = ReleaseManifestDigestError.name
    }
}

/** What Check found wrong with one app: one fixed sentence each. */
export enum ReleaseManifestProblemKind
{
    ImageMissing = 'the image is not in the registry at the manifest digest',
    LabelMissing = 'the image carries no component descriptor label',
    LabelUnreadable = 'the image component descriptor label cannot be read',
    VersionTagTaken = 'the image repository already tags the release version with another digest',
    AssetMissing = 'the repository release v<version> has no component.json asset',
    AssetMismatch = 'the image component label is not the digest of the component.json asset',
    AssetForeign = 'the component.json asset is not this app at the manifest version',
    CommitMissing = 'the repository has no tag v<version>',
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
 * the release version tag is free on every image repository or already names the same digest; the release tag exists.
 * Imports only node builtins and builtin-only relative modules.
 */
export class ReleaseManifest
{
    public static readonly Schema = 1
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly OwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
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
    private static readonly UnknownFieldPrefix = 'unknown field: '
    private static readonly BadComponentPrefix = 'ill-shaped component: '
    private static readonly BadRepositoryPrefix = 'repository is not <owner>/<name>: '
    private static readonly BadComponentVersionPrefix = 'version is not X.Y.Z[-pre-release]: '
    private static readonly RepositoryConflictPrefix = 'a repository named by two apps at different owners or versions: '
    private static readonly ProblemSeparator = ': '

    /** Parses `release.json`; throws a ReleaseManifestInvalidError (or one of its subclasses) for anything but a full manifest. */
    public static Parse(text: string): ReleaseManifestDocument
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
            components[app] = S.ParseComponent(app, raw.components[app])
        }
        S.RefuseRepositoryConflicts(components as Record<ReleaseApp, ReleaseManifestComponent>)
        return { schema: S.Schema, version: raw.version, components: components as Record<ReleaseApp, ReleaseManifestComponent> }
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
        const asked = new Set<string>()
        for (const app of ReleaseApps.All)
        {
            const component = doc.components[app]
            const kinds = await S.CheckImage(app, component, doc.version, registry, ReleaseRegistry.RepositoryPath(namespace, app), assets, componentDigests)
            const name = S.RepositoryName(component.repository)
            if (!asked.has(name))
            {
                asked.add(name)
                const commit = await assets.ReleaseCommit(component.repository, component.version)
                if (commit !== undefined)
                {
                    commits.set(name, commit)
                }
            }
            if (!commits.has(name))
            {
                kinds.push(ReleaseManifestProblemKind.CommitMissing)
            }
            problems.push(...kinds.map(kind => ({ App: app, Kind: kind })))
        }
        return { Problems: problems, ComponentDigests: componentDigests, Commits: commits }
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
            const tagged = await registry.HeadManifest(repo, releaseVersion)
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

    private static ParseComponent(app: ReleaseApp, value: unknown): ReleaseManifestComponent
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
        if (!S.IsRepository(value.repository))
        {
            throw new ReleaseManifestInvalidError(S.BadRepositoryPrefix + app)
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

    /** One repository name, one owner and one version: the descriptor records one commit per repository name. */
    private static RefuseRepositoryConflicts(components: Record<ReleaseApp, ReleaseManifestComponent>): void
    {
        const S = ReleaseManifest
        const seen = new Map<string, ReleaseManifestComponent>()
        for (const app of ReleaseApps.All)
        {
            const component = components[app]
            const name = S.RepositoryName(component.repository)
            const earlier = seen.get(name)
            if (earlier !== undefined && (earlier.repository !== component.repository || earlier.version !== component.version))
            {
                throw new ReleaseManifestInvalidError(S.RepositoryConflictPrefix + app)
            }
            seen.set(name, component)
        }
    }

    private static RefuseUnknownFields(value: Record<string, unknown>, known: ReadonlySet<string>): void
    {
        for (const key of Object.keys(value))
        {
            if (!known.has(key))
            {
                throw new ReleaseManifestInvalidError(ReleaseManifest.UnknownFieldPrefix
                    + (ReleaseDescriptorCodec.IsRepoName(key) ? key : ReleaseManifest.FieldComponent))
            }
        }
    }

    private static IsRepository(repository: string): boolean
    {
        const S = ReleaseManifest
        const parts = repository.split(S.RepositorySeparator)
        return parts.length === 2 && S.OwnerPattern.test(parts[0]) && ReleaseDescriptorCodec.IsRepoName(parts[1])
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
