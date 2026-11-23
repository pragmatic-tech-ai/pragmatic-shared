import type { OciArtifactLayer } from '../oci-registry-client.js'
import type { ReleaseApp } from './release-tag.js'

/**
 * Where a platform release keeps the component descriptor documents of its images: one artifact beside the release
 * descriptor, in the same repository (`pragmatic-release`), tagged `components-<version>`, with one layer per component
 * (media type `application/vnd.pragmatic.component.v1+json`, layer annotation `org.opencontainers.image.title` =
 * `<app>.json`), each layer the exact `component.json` bytes whose digest the release descriptor signs as the image's
 * `componentDigest`. A separate artifact, not extra layers on the release descriptor's, so a reader of the
 * single-layer release descriptor (every platform admin console already deployed) is unchanged; its tag starts with a
 * letter, so it can never be a release version (the catalogue skips it). Imports only builtin-only modules (the release
 * workflow runs the publisher without npm install).
 */
export class ReleaseComponentsArtifact
{
    public static readonly TagPrefix = 'components-'
    public static readonly ArtifactType = 'application/vnd.pragmatic.release.components.v1'
    public static readonly LayerMediaType = 'application/vnd.pragmatic.component.v1+json'
    public static readonly TitleAnnotation = 'org.opencontainers.image.title'
    public static readonly VersionAnnotation = 'org.pragmatic.release.version'
    private static readonly JsonExtension = '.json'

    /** `components-<version>`. */
    public static TagOf(version: string): string
    {
        return ReleaseComponentsArtifact.TagPrefix + version
    }

    /** `<app>.json`, the title of an app's layer. */
    public static TitleOf(app: string): string
    {
        return app + ReleaseComponentsArtifact.JsonExtension
    }

    /** The app a layer title names, or undefined for a title that is not `<name>.json`. */
    public static AppOfTitle(title: string): string | undefined
    {
        const S = ReleaseComponentsArtifact
        return title.endsWith(S.JsonExtension) && title.length > S.JsonExtension.length ? title.slice(0, -S.JsonExtension.length) : undefined
    }

    /** The layers of a release's descriptors, in the given app order. */
    public static Layers(assets: ReadonlyMap<ReleaseApp, Uint8Array>, apps: readonly ReleaseApp[]): OciArtifactLayer[]
    {
        const S = ReleaseComponentsArtifact
        const layers: OciArtifactLayer[] = []
        for (const app of apps)
        {
            const bytes = assets.get(app)
            if (bytes !== undefined)
            {
                layers.push({ mediaType: S.LayerMediaType, bytes, annotations: { [S.TitleAnnotation]: S.TitleOf(app) } })
            }
        }
        return layers
    }
}
