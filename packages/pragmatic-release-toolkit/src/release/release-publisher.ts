import { OciRegistryClient } from '../oci-registry-client.js'
import type { IComponentAssetSource } from './component-asset-source.js'
import { ComponentImageLabel, ComponentLabelError } from './component-image-label.js'
import { ReleaseDescriptorCodec, type ReleaseChart, type ReleaseDescriptor, type ReleaseImage } from './release-descriptor.js'
import { ReleaseManifest, ReleaseManifestProblemKind, type ReleaseManifestDocument, type ReleaseManifestInspection, type ReleaseManifestProblem } from './release-manifest.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseSignature } from './release-signature.js'
import { ReleaseApps, ReleaseTag, type ReleaseApp } from './release-tag.js'
import { ReleaseTrustKeys } from './release-trust-keys.js'
import { ReleaseComponentsArtifact } from './release-components-artifact.js'

/** The published descriptor and the digest of its encoded bytes (the layer digest the registry records and the signature covers). */
export type ReleasePublishResult = { descriptor: ReleaseDescriptor; descriptorDigest: string }

export type ReleasePublishInput = {
    tag: ReleaseTag
    serverCommit: string
    siblingCommits: Record<string, string>
    signingKeyId: string
    privateKeyPem: string
    /** The trusted public key for `signingKeyId` (`release-keys/<id>.pub.pem`): every signature is checked against it before the push. */
    trustedPublicKeyPem: string
}

/**
 * A platform release assembled from `release.json` (pragmatic-platform-release): the manifest names every image by digest,
 * the container repositories' releases supply each component descriptor and commit. `releaseCommit` (the release
 * repository's commit) is recorded as the descriptor's `serverCommit`; `siblingCommits` holds each container repository's.
 */
export type ReleaseManifestPublishInput = {
    Manifest: ReleaseManifestDocument
    Assets: IComponentAssetSource
    ReleaseCommit: string
    SigningKeyId: string
    PrivateKeyPem: string
    TrustedPublicKeyPem: string
    /**
     * The engine chart pushed for this release (`oci://ReleaseDescriptorCodec.ChartReference:<version>`) and its manifest digest:
     * the publisher checks the registry holds that chart at that digest, then writes a schema-3 descriptor binding it.
     * Omitted: a schema-2 release without a chart.
     */
    ChartDigest?: string
}

/** The engine chart is not in the registry at the release version, or another digest is there. Nothing was published. */
export class ReleaseChartMismatchError extends Error
{
    private static readonly ErrorName = 'ReleaseChartMismatchError'
    private static readonly MessagePrefix = 'The engine chart is not in the registry at the given digest for version '
    private static readonly MessageSuffix = '; nothing was published'

    public constructor(public readonly Version: string)
    {
        super(ReleaseChartMismatchError.MessagePrefix + Version + ReleaseChartMismatchError.MessageSuffix)
        this.name = ReleaseChartMismatchError.ErrorName
    }
}

/** The manifest cannot be assembled: ReleaseManifest.Check found problems; nothing was pushed. */
export class ReleaseManifestProblemsError extends Error
{
    private static readonly ErrorName = 'ReleaseManifestProblemsError'
    private static readonly MessagePrefix = 'The release manifest cannot be assembled; nothing was published: '
    private static readonly ProblemSeparator = '; '

    public constructor(public readonly Problems: readonly ReleaseManifestProblem[])
    {
        super(ReleaseManifestProblemsError.MessagePrefix
            + Problems.map(problem => ReleaseManifest.Describe(problem)).join(ReleaseManifestProblemsError.ProblemSeparator))
        this.name = ReleaseManifestProblemsError.ErrorName
    }
}

/** The release commit is not a 40-hex commit sha. */
export class ReleaseCommitInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseCommitInvalidError'
    private static readonly Text = 'The release commit is not a 40-hex commit'

    public constructor()
    {
        super(ReleaseCommitInvalidError.Text)
        this.name = ReleaseCommitInvalidError.ErrorName
    }
}

/**
 * The signing key does not produce signatures the trusted public key verifies. Publishing anyway would record a descriptor
 * every platform rejects, burning the version, so nothing is pushed.
 */
export class ReleaseSigningKeyMismatchError extends Error
{
    private static readonly ErrorName = 'ReleaseSigningKeyMismatchError'
    private static readonly MessagePrefix = 'The signing key does not match the trusted public key '
    private static readonly MessageSuffix = '; nothing was published'
    private static readonly PathSeparator = '/'

    public constructor(public readonly KeyId: string)
    {
        super(ReleaseSigningKeyMismatchError.MessagePrefix + ReleaseTrustKeys.DirName + ReleaseSigningKeyMismatchError.PathSeparator
            + KeyId + ReleaseTrustKeys.Suffix + ReleaseSigningKeyMismatchError.MessageSuffix)
        this.name = ReleaseSigningKeyMismatchError.ErrorName
    }
}

/** A release descriptor already exists for the version; releases are immutable. */
export class ReleaseVersionExistsError extends Error
{
    private static readonly ErrorName = 'ReleaseVersionExistsError'
    private static readonly MessagePrefix = 'Release already published: '

    public constructor(public readonly Version: string)
    {
        super(ReleaseVersionExistsError.MessagePrefix + Version)
        this.name = ReleaseVersionExistsError.ErrorName
    }
}

/** An image of the release is not in the registry under the release version tag. */
export class ReleaseImageMissingError extends Error
{
    private static readonly ErrorName = 'ReleaseImageMissingError'
    private static readonly MessagePrefix = 'Release image missing: '
    private static readonly VersionSeparator = ':'

    public constructor(public readonly App: ReleaseApp, public readonly Version: string)
    {
        super(ReleaseImageMissingError.MessagePrefix + App + ReleaseImageMissingError.VersionSeparator + Version)
        this.name = ReleaseImageMissingError.ErrorName
    }
}

/**
 * An image of the release carries no component descriptor label (or one that cannot be read), so its descriptor cannot be
 * bound to it; nothing is pushed. The reason is a fixed sentence (ComponentLabelFault) or absent for a missing label.
 */
export class ReleaseComponentMissingError extends Error
{
    private static readonly ErrorName = 'ReleaseComponentMissingError'
    private static readonly MessagePrefix = 'Release image has no readable component descriptor label: '
    private static readonly VersionSeparator = ':'
    private static readonly LabelOpen = ' ('
    private static readonly LabelClose = '): '
    private static readonly NoLabel = 'no label'

    public constructor(public readonly App: ReleaseApp, public readonly Version: string, reason?: string)
    {
        super(ReleaseComponentMissingError.MessagePrefix + App + ReleaseComponentMissingError.VersionSeparator + Version
            + ReleaseComponentMissingError.LabelOpen + ComponentImageLabel.Name + ReleaseComponentMissingError.LabelClose
            + (reason ?? ReleaseComponentMissingError.NoLabel))
        this.name = ReleaseComponentMissingError.ErrorName
    }
}

/**
 * Signs the digest of every image of a release and publishes the signed release descriptor as an OCI artifact. Each image's
 * component descriptor digest is read from its label and recorded beside the image digest, so the descriptor signature
 * binds both. The descriptor is pushed last, so its existence means every image was present, labelled and signed.
 * `Publish` takes the images tagged with the release version (the monorepo release); `PublishManifest` takes them by
 * digest from a release manifest, checked first (`Assemble`), and tags each `release-<version>`
 * (ReleaseManifest.ImageTagOf; a container release tags `<version>`) and pushes the component descriptors the images
 * carry (the repositories' `component.json` assets, ReleaseComponentsArtifact) before the descriptor is pushed; `Publish`
 * (the retired monorepo path) pushes none, so its releases carry no descriptors. A publish that
 * stopped after some tags is re-run as is: a tag that already names the manifest digest passes the check and is put
 * again, and the version stays free until the descriptor push.
 */
export class ReleasePublisher
{
    public static readonly DescriptorRepository = 'pragmatic-release'
    public static readonly ArtifactType = 'application/vnd.pragmatic.release.v1'
    public static readonly LayerMediaType = 'application/vnd.pragmatic.release.v1+json'
    public static readonly SignatureAnnotation = 'org.pragmatic.release.signature'
    public static readonly KeyAnnotation = 'org.pragmatic.release.key'
    /** The engine chart's repository under the release namespace (ghcr.io/<namespace>/charts/pragmatic-engine). */
    public static readonly ChartRepository = 'charts/pragmatic-engine'

    public constructor(
        private readonly registry: OciRegistryClient,
        private readonly namespace: string,
        private readonly clock: () => Date = () => new Date(),
    )
    {
    }

    public async CheckVersionFree(version: string): Promise<void>
    {
        const existing = await this.registry.HeadManifest(this.repo(ReleasePublisher.DescriptorRepository), version)
        if (existing !== undefined)
        {
            throw new ReleaseVersionExistsError(version)
        }
    }

    public async Publish(input: ReleasePublishInput): Promise<ReleasePublishResult>
    {
        const S = ReleasePublisher
        const version = input.tag.Version
        await this.CheckVersionFree(version)
        const images: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of ReleaseApps.All)
        {
            const repository = this.repo(app)
            const digest = await this.registry.HeadManifest(repository, version)
            if (digest === undefined)
            {
                throw new ReleaseImageMissingError(app, version)
            }
            const componentDigest = await this.ComponentDigestOf(app, version, repository, digest)
            images[app] = { repository, digest, signature: ReleaseSignature.Sign(digest, input.privateKeyPem), componentDigest }
        }
        const descriptor: ReleaseDescriptor = {
            schema: ReleaseDescriptorCodec.CurrentSchema,
            version,
            channel: input.tag.Channel,
            serverCommit: input.serverCommit,
            siblingCommits: input.siblingCommits,
            builtAt: this.clock().toISOString(),
            signingKeyId: input.signingKeyId,
            images: images as ReleaseDescriptor['images'],
        }
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const descriptorDigest = OciRegistryClient.DigestOf(bytes)
        const signature = ReleaseSignature.Sign(descriptorDigest, input.privateKeyPem)
        S.AssertVerifies(bytes, descriptorDigest, signature, input.signingKeyId, input.trustedPublicKeyPem)
        await this.registry.PushArtifact(this.repo(S.DescriptorRepository), version, S.ArtifactType, S.LayerMediaType, bytes, {
            [S.SignatureAnnotation]: signature,
            [S.KeyAnnotation]: input.signingKeyId,
        })
        return { descriptor, descriptorDigest }
    }

    /** Checks a release manifest against the registry and the container repositories' releases; never writes. */
    public Assemble(manifest: ReleaseManifestDocument, assets: IComponentAssetSource): Promise<ReleaseManifestInspection>
    {
        return ReleaseManifest.Inspect(manifest, this.registry, assets, this.namespace)
    }

    public async PublishManifest(input: ReleaseManifestPublishInput): Promise<ReleasePublishResult>
    {
        const S = ReleasePublisher
        if (!ReleaseDescriptorCodec.IsCommit(input.ReleaseCommit))
        {
            throw new ReleaseCommitInvalidError()
        }
        const tag = ReleaseTag.FromVersion(input.Manifest.version)
        await this.CheckVersionFree(tag.Version)
        const inspection = await this.Assemble(input.Manifest, input.Assets)
        if (inspection.Problems.length > 0)
        {
            throw new ReleaseManifestProblemsError(inspection.Problems)
        }
        const images: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of ReleaseApps.All)
        {
            const digest = input.Manifest.components[app].digest
            const componentDigest = inspection.ComponentDigests.get(app)
            if (componentDigest === undefined)
            {
                throw new ReleaseComponentMissingError(app, tag.Version)
            }
            images[app] = { repository: this.repo(app), digest, signature: ReleaseSignature.Sign(digest, input.PrivateKeyPem), componentDigest }
        }
        const chart = input.ChartDigest === undefined ? undefined : await this.ChartOf(tag.Version, input.ChartDigest)
        const descriptor: ReleaseDescriptor = {
            schema: chart === undefined ? ReleaseDescriptorCodec.CurrentSchema : ReleaseDescriptorCodec.ChartSchema,
            version: tag.Version,
            channel: tag.Channel,
            serverCommit: input.ReleaseCommit,
            siblingCommits: Object.fromEntries(inspection.Commits),
            builtAt: this.clock().toISOString(),
            signingKeyId: input.SigningKeyId,
            images: images as ReleaseDescriptor['images'],
        }
        if (chart !== undefined)
        {
            descriptor.chart = chart
        }
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const descriptorDigest = OciRegistryClient.DigestOf(bytes)
        const signature = ReleaseSignature.Sign(descriptorDigest, input.PrivateKeyPem)
        S.AssertVerifies(bytes, descriptorDigest, signature, input.SigningKeyId, input.TrustedPublicKeyPem)
        // The checks above took a while: another publish of the version may have finished or begun tagging meanwhile.
        await this.CheckVersionFree(tag.Version)
        await this.CheckImageTagsFree(input.Manifest, tag.Version)
        for (const app of ReleaseApps.All)
        {
            await this.registry.TagManifest(this.repo(app), input.Manifest.components[app].digest, ReleaseManifest.ImageTagOf(tag.Version))
        }
        // The descriptors the release carries (ReleaseComponentsArtifact), before the descriptor: its existence means they
        // are there too. Each layer is the component.json whose digest the descriptor signs as the image's componentDigest.
        await this.registry.PushLayeredArtifact(this.repo(S.DescriptorRepository), ReleaseComponentsArtifact.TagOf(tag.Version),
            ReleaseComponentsArtifact.ArtifactType, ReleaseComponentsArtifact.Layers(inspection.ComponentAssets, ReleaseApps.All),
            { [ReleaseComponentsArtifact.VersionAnnotation]: tag.Version })
        // Again just before the push. A rival publish that pushes its descriptor between this check and the push below
        // can still overwrite it: the registry offers no conditional put, so two runs must not publish one version at
        // once (publish.yml and the release repository's workflow run one at a time).
        await this.CheckVersionFree(tag.Version)
        await this.registry.PushArtifact(this.repo(S.DescriptorRepository), tag.Version, S.ArtifactType, S.LayerMediaType, bytes, {
            [S.SignatureAnnotation]: signature,
            [S.KeyAnnotation]: input.SigningKeyId,
        })
        return { descriptor, descriptorDigest }
    }

    /** The chart the registry holds at `<chart repository>:<version>`, refused unless its manifest digest is `digest`. */
    private async ChartOf(version: string, digest: string): Promise<ReleaseChart>
    {
        const S = ReleasePublisher
        const held = await this.registry.HeadManifest(this.repo(S.ChartRepository), version)
        if (held !== digest)
        {
            throw new ReleaseChartMismatchError(version)
        }
        return { reference: ReleaseDescriptorCodec.ChartReference, version, digest }
    }

    /** Every image's `release-<version>` tag is free or already names the manifest digest (a re-run); else nothing is tagged. */
    private async CheckImageTagsFree(manifest: ReleaseManifestDocument, version: string): Promise<void>
    {
        const problems: ReleaseManifestProblem[] = []
        for (const app of ReleaseApps.All)
        {
            const tagged = await this.registry.HeadManifest(this.repo(app), ReleaseManifest.ImageTagOf(version))
            if (tagged !== undefined && tagged !== manifest.components[app].digest)
            {
                problems.push({ App: app, Kind: ReleaseManifestProblemKind.VersionTagTaken })
            }
        }
        if (problems.length > 0)
        {
            throw new ReleaseManifestProblemsError(problems)
        }
    }

    /**
     * What the platform's catalogue will check, run on the bytes about to be pushed: the descriptor decodes, and its signature
     * and every image signature verify against the trusted public key. Throws before any push when one does not.
     */
    private static AssertVerifies(bytes: Uint8Array, descriptorDigest: string, signature: string, signingKeyId: string, trustedPublicKeyPem: string): void
    {
        const decoded = ReleaseDescriptorCodec.Decode(bytes)
        const key = trustedPublicKeyPem
        if (!ReleaseSignature.Verifies(descriptorDigest, signature, key))
        {
            throw new ReleaseSigningKeyMismatchError(signingKeyId)
        }
        for (const [, image] of ReleaseDescriptorCodec.ImagesOf(decoded))
        {
            if (!ReleaseSignature.Verifies(image.digest, image.signature, key))
            {
                throw new ReleaseSigningKeyMismatchError(signingKeyId)
            }
        }
    }

    private async ComponentDigestOf(app: ReleaseApp, version: string, repository: string, digest: string): Promise<string>
    {
        let component: string | undefined
        try
        {
            component = await ComponentImageLabel.Read(this.registry, repository, digest)
        }
        catch (error)
        {
            if (error instanceof ComponentLabelError)
            {
                throw new ReleaseComponentMissingError(app, version, error.Fault)
            }
            throw error
        }
        if (component === undefined)
        {
            throw new ReleaseComponentMissingError(app, version)
        }
        return component
    }

    private repo(name: string): string
    {
        return ReleaseRegistry.RepositoryPath(this.namespace, name)
    }
}
