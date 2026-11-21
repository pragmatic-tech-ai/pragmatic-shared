import { OciRegistryClient } from '../oci-registry-client.js'
import type { IComponentAssetSource } from './component-asset-source.js'
import { ComponentImageLabel, ComponentLabelError } from './component-image-label.js'
import { ReleaseDescriptorCodec, type ReleaseDescriptor, type ReleaseImage } from './release-descriptor.js'
import { ReleaseManifest, type ReleaseManifestDocument, type ReleaseManifestInspection, type ReleaseManifestProblem } from './release-manifest.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseSignature } from './release-signature.js'
import { ReleaseApps, ReleaseTag, type ReleaseApp } from './release-tag.js'
import { ReleaseTrustKeys } from './release-trust-keys.js'

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
    manifest: ReleaseManifestDocument
    assets: IComponentAssetSource
    releaseCommit: string
    signingKeyId: string
    privateKeyPem: string
    trustedPublicKeyPem: string
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
 * (ReleaseManifest.ImageTagOf; a container release tags `<version>`) before the descriptor is pushed. A publish that
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
        S.AssertVerifies(bytes, descriptorDigest, signature, input)
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
        if (!ReleaseDescriptorCodec.IsCommit(input.releaseCommit))
        {
            throw new ReleaseCommitInvalidError()
        }
        const tag = ReleaseTag.FromVersion(input.manifest.version)
        await this.CheckVersionFree(tag.Version)
        const inspection = await this.Assemble(input.manifest, input.assets)
        if (inspection.Problems.length > 0)
        {
            throw new ReleaseManifestProblemsError(inspection.Problems)
        }
        const images: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of ReleaseApps.All)
        {
            const digest = input.manifest.components[app].digest
            const componentDigest = inspection.ComponentDigests.get(app)
            if (componentDigest === undefined)
            {
                throw new ReleaseComponentMissingError(app, tag.Version)
            }
            images[app] = { repository: this.repo(app), digest, signature: ReleaseSignature.Sign(digest, input.privateKeyPem), componentDigest }
        }
        const descriptor: ReleaseDescriptor = {
            schema: ReleaseDescriptorCodec.CurrentSchema,
            version: tag.Version,
            channel: tag.Channel,
            serverCommit: input.releaseCommit,
            siblingCommits: Object.fromEntries(inspection.Commits),
            builtAt: this.clock().toISOString(),
            signingKeyId: input.signingKeyId,
            images: images as ReleaseDescriptor['images'],
        }
        const bytes = ReleaseDescriptorCodec.Encode(descriptor)
        const descriptorDigest = OciRegistryClient.DigestOf(bytes)
        const signature = ReleaseSignature.Sign(descriptorDigest, input.privateKeyPem)
        S.AssertVerifies(bytes, descriptorDigest, signature, input)
        for (const app of ReleaseApps.All)
        {
            await this.registry.TagManifest(this.repo(app), input.manifest.components[app].digest, ReleaseManifest.ImageTagOf(tag.Version))
        }
        await this.registry.PushArtifact(this.repo(S.DescriptorRepository), tag.Version, S.ArtifactType, S.LayerMediaType, bytes, {
            [S.SignatureAnnotation]: signature,
            [S.KeyAnnotation]: input.signingKeyId,
        })
        return { descriptor, descriptorDigest }
    }

    /**
     * What the platform's catalogue will check, run on the bytes about to be pushed: the descriptor decodes, and its signature
     * and every image signature verify against the trusted public key. Throws before any push when one does not.
     */
    private static AssertVerifies(bytes: Uint8Array, descriptorDigest: string, signature: string, input: { signingKeyId: string; trustedPublicKeyPem: string }): void
    {
        const decoded = ReleaseDescriptorCodec.Decode(bytes)
        const key = input.trustedPublicKeyPem
        if (!ReleaseSignature.Verifies(descriptorDigest, signature, key))
        {
            throw new ReleaseSigningKeyMismatchError(input.signingKeyId)
        }
        for (const [, image] of ReleaseDescriptorCodec.ImagesOf(decoded))
        {
            if (!ReleaseSignature.Verifies(image.digest, image.signature, key))
            {
                throw new ReleaseSigningKeyMismatchError(input.signingKeyId)
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
