import { Channel } from '../channel.js'

export enum ReleaseApp
{
    PlatformAdmin = 'pragmatic-platform-admin',
    PlatformEdge = 'pragmatic-platform-edge',
    EnvServer = 'pragmatic-env-server',
    EnvGateway = 'pragmatic-env-gateway',
    HiveAgent = 'pragmatic-hive-agent',
    TenantAdmin = 'pragmatic-tenant-admin',
    TenantIdp = 'pragmatic-tenant-idp',
    UiUnpack = 'pragmatic-ui-unpack',
    Postgres = 'pragmatic-postgres',
    HostAgent = 'pragmatic-host-agent',
}

export class ReleaseApps
{
    /** The eight Node apps a schema-1 release descriptor carries (pinned: later apps never join schema 1). */
    public static readonly Schema1Apps: readonly ReleaseApp[] = [
        ReleaseApp.PlatformAdmin,
        ReleaseApp.PlatformEdge,
        ReleaseApp.EnvServer,
        ReleaseApp.EnvGateway,
        ReleaseApp.HiveAgent,
        ReleaseApp.TenantAdmin,
        ReleaseApp.TenantIdp,
        ReleaseApp.UiUnpack,
    ]

    /** The nine images a schema-2 or schema-3 release descriptor carries: schema 1 plus `pragmatic-postgres` (pinned). */
    public static readonly Schema2Apps: readonly ReleaseApp[] = [...ReleaseApps.Schema1Apps, ReleaseApp.Postgres]

    /**
     * The Node apps, each a container repository whose image the closure check measures: schema 1's eight plus
     * `pragmatic-host-agent` (C5.1, the agent on a hosting machine that places Hosted hives).
     */
    public static readonly NodeApps: readonly ReleaseApp[] = [...ReleaseApps.Schema1Apps, ReleaseApp.HostAgent]

    /**
     * Every image a release ships (release.json requires each, a schema-4 descriptor carries each): the schema-2 nine
     * (`pragmatic-postgres` is docker/postgres/Dockerfile, the Postgres a hive or the platform host runs) plus
     * `pragmatic-host-agent`.
     */
    public static readonly All: readonly ReleaseApp[] = [...ReleaseApps.Schema2Apps, ReleaseApp.HostAgent]
}

export class ReleaseTagInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseTagInvalidError'
    private static readonly MessagePrefix = 'Invalid release tag: '

    public constructor(ref: string)
    {
        super(ReleaseTagInvalidError.MessagePrefix + ref)
        this.name = ReleaseTagInvalidError.ErrorName
    }
}

/** A `release/X.Y.Z` (stable) or `release/X.Y.Z-early.N` (early access) git tag. */
export class ReleaseTag
{
    /** The git tag name prefix in front of the version. */
    public static readonly Prefix = 'release/'
    private static readonly RefPrefix = 'refs/tags/'
    private static readonly Pattern = /^release\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(-early\.(?:0|[1-9]\d*))?)$/

    private constructor(public readonly Version: string, public readonly Channel: Channel)
    {
    }

    public static Parse(ref: string): ReleaseTag
    {
        const name = ref.startsWith(ReleaseTag.RefPrefix) ? ref.slice(ReleaseTag.RefPrefix.length) : ref
        const match = ReleaseTag.Pattern.exec(name)
        if (match === null)
        {
            throw new ReleaseTagInvalidError(ref)
        }
        const channel = match[2] === undefined ? Channel.Stable : Channel.EarlyAccess
        return new ReleaseTag(match[1], channel)
    }

    /** The release tag for a bare version (`1.4.0`, `1.4.0-early.2`); throws ReleaseTagInvalidError for anything else. */
    public static FromVersion(version: string): ReleaseTag
    {
        return ReleaseTag.Parse(ReleaseTag.Prefix + version)
    }
}
