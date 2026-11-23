import { ComponentDescriptorCodec, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { OciRegistryClient, type OciPulledLayer } from '../oci-registry-client.js'
import { ComponentDescriptorSet } from './component-descriptor-set.js'
import { ReleaseComponentsArtifact } from './release-components-artifact.js'
import { ReleaseDescriptorCodec } from './release-descriptor.js'
import { ReleasePublisher } from './release-publisher.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseSignature } from './release-signature.js'

/** The release keys a reader trusts, by key id (ReleaseTrustKeys). */
export interface IReleaseTrust
{
    KeyFor(keyId: string): string | undefined
}

/**
 * A component descriptor the release carries is not the one its signed descriptor binds: the layer's digest differs from
 * the signed `componentDigest`, it names another component, or (`Actual` undefined) the app has no layer.
 */
export class ReleaseDescriptorMismatchError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorMismatchError'
    private static readonly Prefix = 'The release carries a component descriptor its signature does not bind: '
    private static readonly SignedText = ' signed '
    private static readonly ActualText = ', carried '
    private static readonly NoLayer = 'none'

    public constructor(public readonly App: string, public readonly Signed: string, public readonly Actual: string | undefined)
    {
        const S = ReleaseDescriptorMismatchError
        super(S.Prefix + App + S.SignedText + Signed + S.ActualText + (Actual ?? S.NoLayer))
        this.name = S.ErrorName
    }
}

/** The release carries no component descriptors: published before they were (no `components-<version>` artifact), or a
 *  schema-1 release (no signed component digests). */
export class ReleaseDescriptorsAbsentError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorsAbsentError'
    private static readonly Prefix = 'The release carries no component descriptors: '

    public constructor(public readonly Version: string)
    {
        super(ReleaseDescriptorsAbsentError.Prefix + Version)
        this.name = ReleaseDescriptorsAbsentError.ErrorName
    }
}

/** The release descriptor's signature does not verify against a trusted key, so nothing it binds is believed. */
export class ReleaseDescriptorUnverifiedError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorUnverifiedError'
    private static readonly Prefix = 'The release descriptor is not signed by a trusted release key: '

    public constructor(public readonly Version: string)
    {
        super(ReleaseDescriptorUnverifiedError.Prefix + Version)
        this.name = ReleaseDescriptorUnverifiedError.ErrorName
    }
}

/**
 * Reads the component descriptors a published platform release carries (ReleaseComponentsArtifact): the release
 * descriptor is pulled and its signature checked against the trusted keys, then every layer of `components-<version>` is
 * checked against the `componentDigest` that signature binds for its app, so a descriptor answered here is exactly the
 * one the release's image of that app carries.
 */
export class ReleaseComponentDescriptors
{
    public constructor(
        private readonly registry: OciRegistryClient,
        private readonly trust: IReleaseTrust,
        private readonly namespace: string = ReleaseRegistry.DefaultNamespace,
    )
    {
    }

    public async Descriptors(version: string): Promise<ComponentDescriptorSet>
    {
        const repo = ReleaseRegistry.RepositoryPath(this.namespace, ReleasePublisher.DescriptorRepository)
        const signed = await this.SignedComponentDigests(repo, version)
        if (signed.size === 0)
        {
            throw new ReleaseDescriptorsAbsentError(version)
        }
        const artifact = await this.registry.PullArtifactLayers(repo, ReleaseComponentsArtifact.TagOf(version))
        if (artifact === undefined)
        {
            throw new ReleaseDescriptorsAbsentError(version)
        }
        const byApp = ReleaseComponentDescriptors.LayersByApp(artifact.layers)
        const descriptors: ComponentDescriptor[] = []
        for (const [app, digest] of signed)
        {
            descriptors.push(ReleaseComponentDescriptors.Checked(app, digest, byApp.get(app)))
        }
        return ComponentDescriptorSet.FromDescriptors(descriptors)
    }

    /** The signed componentDigest per app of a verified release descriptor (empty for schema 1). */
    private async SignedComponentDigests(repo: string, version: string): Promise<Map<string, string>>
    {
        const pulled = await this.registry.PullArtifactLayer(repo, version)
        const keyId = pulled.annotations[ReleasePublisher.KeyAnnotation]
        const signature = pulled.annotations[ReleasePublisher.SignatureAnnotation]
        const key = keyId === undefined ? undefined : this.trust.KeyFor(keyId)
        if (key === undefined || signature === undefined || !ReleaseSignature.Verifies(pulled.layerDigest, signature, key))
        {
            throw new ReleaseDescriptorUnverifiedError(version)
        }
        const descriptor = ReleaseDescriptorCodec.Decode(pulled.layer)
        // A signed descriptor of another release re-tagged under this version, or one naming another key, is not this one.
        if (descriptor.version !== version || descriptor.signingKeyId !== keyId)
        {
            throw new ReleaseDescriptorUnverifiedError(version)
        }
        const digests = new Map<string, string>()
        for (const [app, image] of ReleaseDescriptorCodec.ImagesOf(descriptor))
        {
            if (image.componentDigest !== undefined)
            {
                digests.set(app, image.componentDigest)
            }
        }
        return digests
    }

    private static LayersByApp(layers: readonly OciPulledLayer[]): Map<string, OciPulledLayer>
    {
        const A = ReleaseComponentsArtifact
        const byApp = new Map<string, OciPulledLayer>()
        for (const layer of layers)
        {
            const title = layer.annotations[A.TitleAnnotation]
            const app = title === undefined ? undefined : A.AppOfTitle(title)
            if (layer.mediaType === A.LayerMediaType && app !== undefined && !byApp.has(app))
            {
                byApp.set(app, layer)
            }
        }
        return byApp
    }

    private static Checked(app: string, signed: string, layer: OciPulledLayer | undefined): ComponentDescriptor
    {
        if (layer === undefined)
        {
            throw new ReleaseDescriptorMismatchError(app, signed, undefined)
        }
        const actual = OciRegistryClient.DigestOf(layer.bytes)
        if (actual !== signed)
        {
            throw new ReleaseDescriptorMismatchError(app, signed, actual)
        }
        const descriptor = ComponentDescriptorCodec.Parse(new TextDecoder().decode(layer.bytes))
        if (descriptor.Name !== app)
        {
            throw new ReleaseDescriptorMismatchError(app, signed, actual)
        }
        return descriptor
    }
}
