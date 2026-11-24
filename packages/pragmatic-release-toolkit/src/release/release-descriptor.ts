import { Channel } from '../channel.js'
import { ReleaseApp, ReleaseApps } from './release-tag.js'

/**
 * One image of a release: its repository, the digest of its manifest (an index for a multi-arch or attested image) and the
 * release key's signature over that digest. From schema 2 on, also the content digest of the component descriptor the image
 * carries (`/pragmatic/component.json`, label `ai.pragmatic-tech.component.digest`): the descriptor signature covers it, so
 * one signature binds image and descriptor. A schema-1 image has none.
 */
export type ReleaseImage = { repository: string; digest: string; signature: string; componentDigest?: string }

/** Every app's image; a schema-1 descriptor (published before pragmatic-postgres existed) has none for it. */
export type ReleaseImages = Omit<Record<ReleaseApp, ReleaseImage>, ReleaseApp.Postgres> & { [ReleaseApp.Postgres]?: ReleaseImage }

/**
 * Schema 1: the eight Node apps (ReleaseApps.NodeApps). Schema 2: every app (ReleaseApps.All), adding pragmatic-postgres, and
 * per image the component descriptor digest. Schema 3: schema 2 plus the management engine chart (`chart`), whose manifest
 * digest the descriptor signature then binds with the images.
 */
export type ReleaseDescriptorSchema = 1 | 2 | 3

/**
 * The management engine Helm chart of a release (C3.2): `oci://<reference>` at `version` (the release version), whose OCI
 * manifest digest is `digest`. The chart carries the release's image digests, so pinning it pins what a hive installs.
 */
export type ReleaseChart = { reference: string; version: string; digest: string }

export type ReleaseDescriptor = {
    schema: ReleaseDescriptorSchema
    version: string
    channel: Channel
    serverCommit: string
    siblingCommits: Record<string, string>
    builtAt: string
    signingKeyId: string
    images: ReleaseImages
    /** Schema 3 only: the engine chart. */
    chart?: ReleaseChart
}

export class ReleaseDescriptorInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorInvalidError'
    private static readonly MessagePrefix = 'Invalid release descriptor: '

    /** The codec's reason without the message prefix (a fixed sentence plus at most a field or app name). */
    public constructor(public readonly Reason: string)
    {
        super(ReleaseDescriptorInvalidError.MessagePrefix + Reason)
        this.name = ReleaseDescriptorInvalidError.ErrorName
    }
}

/** Canonical (sorted-key, whitespace-free) JSON codec so the descriptor's sha256 is stable. */
export class ReleaseDescriptorCodec
{
    /** The schema the publisher writes for a release without a chart (the tag-mode publish). */
    public static readonly CurrentSchema: ReleaseDescriptorSchema = 2
    /** The schema of a release that carries the engine chart (`publish --manifest --chart-digest`). */
    public static readonly ChartSchema: ReleaseDescriptorSchema = 3
    /** The engine chart's repository under a release namespace. */
    public static readonly ChartRepository = 'charts/pragmatic-engine'
    /** Where the published releases' engine chart lives (`oci://` + this): the default registry and namespace. */
    public static readonly ChartReference = 'ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    private static readonly ReferenceSeparator = '/'
    private static readonly SchemaApps = new Map<unknown, readonly ReleaseApp[]>([[1, ReleaseApps.NodeApps], [2, ReleaseApps.All], [3, ReleaseApps.All]])
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly CommitPattern = /^[0-9a-f]{40}$/
    /** A plain repository name: no separators, never a dot segment (`.`, `..`) nor `__proto__`. */
    private static readonly RepoNamePattern = /^(?!__proto__$)(?!\.{1,2}$)[A-Za-z0-9._-]+$/
    private static readonly NotObject = 'not an object'
    private static readonly NotJson = 'not valid JSON'
    private static readonly BadSchema = 'schema must be 1, 2 or 3'
    private static readonly BadChart = 'chart must name its reference, the release version and a sha256 digest'
    private static readonly UnexpectedChart = 'only a schema-3 descriptor carries a chart'
    private static readonly ChartSchemas: ReadonlySet<unknown> = new Set([3])
    private static readonly FieldChart = 'chart'
    private static readonly BadChannel = 'channel is not a known channel'
    private static readonly BadServerCommit = 'serverCommit is not a 40-hex commit'
    private static readonly BadSiblingCommits = 'siblingCommits must map names to 40-hex commits'
    private static readonly MissingFieldPrefix = 'missing or ill-shaped field: '
    private static readonly MissingImagePrefix = 'missing image: '
    private static readonly BadImagePrefix = 'ill-shaped image: '
    private static readonly BadDigestPrefix = 'bad digest for image: '
    private static readonly BadComponentDigestPrefix = 'bad component digest for image: '
    /** The schemas whose images carry a component descriptor digest. */
    private static readonly ComponentSchemas: ReadonlySet<unknown> = new Set([2, 3])
    private static readonly FieldVersion = 'version'
    private static readonly FieldBuiltAt = 'builtAt'
    private static readonly FieldSigningKeyId = 'signingKeyId'
    private static readonly FieldImages = 'images'

    /** The sibling-name rule the descriptor and the publish CLI's siblings file share. */
    public static IsRepoName(name: string): boolean
    {
        return ReleaseDescriptorCodec.RepoNamePattern.test(name)
    }

    /** A sibling commit: exactly 40 lowercase hex characters. */
    public static IsCommit(commit: unknown): commit is string
    {
        return typeof commit === 'string' && ReleaseDescriptorCodec.CommitPattern.test(commit)
    }

    /** The apps a descriptor of this schema carries, in ReleaseApps.All order. */
    public static AppsOf(schema: ReleaseDescriptorSchema): readonly ReleaseApp[]
    {
        return ReleaseDescriptorCodec.SchemaApps.get(schema) ?? []
    }

    /** The descriptor's images, one per app its schema carries, in ReleaseApps.All order. */
    public static ImagesOf(d: ReleaseDescriptor): [ReleaseApp, ReleaseImage][]
    {
        const images: Partial<Record<ReleaseApp, ReleaseImage>> = d.images
        const result: [ReleaseApp, ReleaseImage][] = []
        for (const app of ReleaseDescriptorCodec.AppsOf(d.schema))
        {
            const image = images[app]
            if (image !== undefined)
            {
                result.push([app, image])
            }
        }
        return result
    }

    /** `<registry host>/<namespace>/charts/pragmatic-engine`: the chart reference of a release published under `namespace`. */
    public static ChartReferenceOf(registryHost: string, namespace: string): string
    {
        const C = ReleaseDescriptorCodec
        return registryHost + C.ReferenceSeparator + namespace + C.ReferenceSeparator + C.ChartRepository
    }

    /** The engine chart a schema-3 descriptor binds; undefined for schemas 1 and 2. */
    public static ChartOf(d: ReleaseDescriptor): ReleaseChart | undefined
    {
        return d.chart === undefined ? undefined : { ...d.chart }
    }

    public static Encode(d: ReleaseDescriptor): Uint8Array
    {
        return new TextEncoder().encode(JSON.stringify(ReleaseDescriptorCodec.sortKeys(d)))
    }

    /** Validates in a fixed order: schema, version, channel, serverCommit, siblingCommits, builtAt, signingKeyId, images, chart. */
    public static Decode(bytes: Uint8Array): ReleaseDescriptor
    {
        let raw: unknown
        try
        {
            raw = JSON.parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.NotJson)
        }
        if (!ReleaseDescriptorCodec.isRecord(raw))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.NotObject)
        }
        const apps = ReleaseDescriptorCodec.SchemaApps.get(raw.schema)
        if (apps === undefined)
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSchema)
        }
        const version = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldVersion)
        if (!Object.values(Channel).includes(raw.channel as Channel))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadChannel)
        }
        if (typeof raw.serverCommit !== 'string' || !ReleaseDescriptorCodec.CommitPattern.test(raw.serverCommit))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadServerCommit)
        }
        const siblingCommits = ReleaseDescriptorCodec.decodeSiblings(raw.siblingCommits)
        const builtAt = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldBuiltAt)
        const signingKeyId = ReleaseDescriptorCodec.requireString(raw, ReleaseDescriptorCodec.FieldSigningKeyId)
        const images = ReleaseDescriptorCodec.decodeImages(raw.images, apps, ReleaseDescriptorCodec.ComponentSchemas.has(raw.schema))
        const descriptor: ReleaseDescriptor = {
            schema: raw.schema as ReleaseDescriptorSchema,
            version,
            channel: raw.channel as Channel,
            serverCommit: raw.serverCommit,
            siblingCommits,
            builtAt,
            signingKeyId,
            images,
        }
        if (ReleaseDescriptorCodec.ChartSchemas.has(raw.schema))
        {
            descriptor.chart = ReleaseDescriptorCodec.decodeChart(raw[ReleaseDescriptorCodec.FieldChart], version)
        }
        else if (raw[ReleaseDescriptorCodec.FieldChart] !== undefined)
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.UnexpectedChart)
        }
        return descriptor
    }

    /** A schema-3 chart: a non-empty reference, the descriptor's own version and a sha256 digest. */
    private static decodeChart(value: unknown, version: string): ReleaseChart
    {
        const C = ReleaseDescriptorCodec
        if (!C.isRecord(value)
            || typeof value.reference !== 'string' || value.reference.length === 0
            || value.version !== version
            || typeof value.digest !== 'string' || !C.DigestPattern.test(value.digest))
        {
            throw new ReleaseDescriptorInvalidError(C.BadChart)
        }
        return { reference: value.reference, version: value.version, digest: value.digest }
    }

    private static decodeSiblings(value: unknown): Record<string, string>
    {
        if (!ReleaseDescriptorCodec.isRecord(value))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSiblingCommits)
        }
        const result: Record<string, string> = {}
        for (const [name, commit] of Object.entries(value))
        {
            if (!ReleaseDescriptorCodec.IsRepoName(name))
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSiblingCommits)
            }
            if (!ReleaseDescriptorCodec.IsCommit(commit))
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadSiblingCommits)
            }
            result[name] = commit
        }
        return result
    }

    private static decodeImages(value: unknown, apps: readonly ReleaseApp[], withComponent: boolean): ReleaseImages
    {
        if (!ReleaseDescriptorCodec.isRecord(value))
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingFieldPrefix + ReleaseDescriptorCodec.FieldImages)
        }
        const result: Partial<Record<ReleaseApp, ReleaseImage>> = {}
        for (const app of apps)
        {
            const image = value[app]
            if (image === undefined)
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingImagePrefix + app)
            }
            if (!ReleaseDescriptorCodec.isRecord(image)
                || typeof image.repository !== 'string'
                || image.repository.length === 0
                || typeof image.digest !== 'string'
                || typeof image.signature !== 'string'
                || image.signature.length === 0)
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadImagePrefix + app)
            }
            if (!ReleaseDescriptorCodec.DigestPattern.test(image.digest))
            {
                throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadDigestPrefix + app)
            }
            const decoded: ReleaseImage = { repository: image.repository, digest: image.digest, signature: image.signature }
            if (withComponent)
            {
                if (typeof image.componentDigest !== 'string' || !ReleaseDescriptorCodec.DigestPattern.test(image.componentDigest))
                {
                    throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.BadComponentDigestPrefix + app)
                }
                decoded.componentDigest = image.componentDigest
            }
            result[app] = decoded
        }
        return result as ReleaseImages
    }

    private static requireString(raw: Record<string, unknown>, field: string): string
    {
        const value = raw[field]
        if (typeof value !== 'string' || value.length === 0)
        {
            throw new ReleaseDescriptorInvalidError(ReleaseDescriptorCodec.MissingFieldPrefix + field)
        }
        return value
    }

    private static isRecord(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    private static sortKeys(value: unknown): unknown
    {
        if (Array.isArray(value))
        {
            return value.map(item => ReleaseDescriptorCodec.sortKeys(item))
        }
        if (ReleaseDescriptorCodec.isRecord(value))
        {
            const sorted: Record<string, unknown> = {}
            for (const key of Object.keys(value).sort())
            {
                sorted[key] = ReleaseDescriptorCodec.sortKeys(value[key])
            }
            return sorted
        }
        return value
    }
}
