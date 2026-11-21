import { ReleaseApp } from '../release/release-tag.js'

/** How a container repository builds its image. */
export enum ContainerKind
{
    /** A Node app: the rendered Dockerfile (deps, compile, component, build, runtime). */
    Node = 'node',
    /** The repository keeps its own Dockerfile (pragmatic-postgres); only the descriptor is built with Node. */
    ExternalDockerfile = 'external',
}

export enum HealthScheme
{
    Http = 'http',
    Https = 'https',
}

/** The image's HEALTHCHECK: GET /healthz on 127.0.0.1 at the port the environment variable names (else the default). */
export interface IContainerHealthcheck
{
    Scheme: HealthScheme
    PortVariable: string
    DefaultPort?: number
    /** HTTPS without verifying the peer: the certificate is issued for the public host, the probe checks liveness only. */
    Insecure?: boolean
}

/** What one release app's image needs beyond the common template, as pragmatic-server's docker/images/Dockerfile had it. */
export interface IContainerProfile
{
    Kind: ContainerKind
    /** Also built for linux/arm64 (on native runners): CI's arm64 job and the release's per-arch bake. */
    MultiArch: boolean
    AptPackages: readonly string[]
    /** The pinned kubectl, kind and docker CLI stage (the platform admin console until C5.3). */
    ProvisioningTools: boolean
    Env: ReadonlyArray<readonly [string, string]>
    Ports: readonly number[]
    Healthcheck?: IContainerHealthcheck
    /** CI runs `tests/image.test.sh <image>` on the baked image. */
    ImageTest: boolean
    /**
     * CI starts the baked image once with no configuration (container-ci.yml `start-smoke`): false where the image
     * has its own start test and is no Node entry (pragmatic-postgres).
     */
    StartSmoke: boolean
    /** The configuration refusal the app prints when started with no configuration, where the default pattern misses it. */
    StartSmokeRefusal?: string
    /** The repository installs with `legacy-peer-deps` (.npmrc and the image's deps stage): it takes no TODL peer. */
    LegacyPeerDeps?: boolean
    /** Lines appended to the common `.dockerignore` (local secrets and dev data); `#` comments allowed. */
    DockerIgnore?: readonly string[]
    /** Lines appended to the common `.gitignore` (local secrets and dev data); `#` comments allowed. */
    GitIgnore?: readonly string[]
    /** A Helm chart CI lints and renders; empty for none. */
    HelmChart: string
    /** The image closure check runs (CI and the image build); false where the image is not a Node closure. */
    ClosureCheck: boolean
    /** The package.json whose version the release tag must equal (the component descriptor's version is that one). */
    VersionManifest: string
}

/** The per-app facts the container template renders, one entry per release app. */
export class ContainerProfiles
{
    private static readonly None: readonly string[] = []
    private static readonly OpenSsl: readonly string[] = ['openssl']
    private static readonly NoChart = ''
    private static readonly EnvServerChart = 'helm/pragmatic-env-server'
    private static readonly RootManifest = 'package.json'
    private static readonly EnvServerManifest = 'server/package.json'
    private static readonly HttpPort = 8080
    private static readonly HttpPortVariable = 'PRAGMATIC_PORT'
    private static readonly AdminPort = 7000
    private static readonly AdminInternalPort = 7001
    private static readonly AdminPortVariable = 'PRAGMATIC_ADMIN_PORT'
    private static readonly RoleVariable = 'PRAGMATIC_CONTROL_PLANE_ROLE'
    private static readonly AdminRole = 'admin'
    private static readonly AgentChannelPort = 7100
    private static readonly AgentChannelPortVariable = 'PRAGMATIC_AGENT_CHANNEL_PORT'
    private static readonly AgentChannelBindVariable = 'PRAGMATIC_AGENT_CHANNEL_BIND'
    private static readonly AllInterfaces = '0.0.0.0'
    private static readonly TenantAdminPortVariable = 'PRAGMATIC_TENANT_ADMIN_PORT'
    private static readonly IdpPort = 7100
    private static readonly IdpPortVariable = 'PRAGMATIC_IDP_PORT'
    /** With no configuration the platform admin console stops on its missing database setting. */
    private static readonly PlatformAdminRefusal = 'PRAGMATIC_ADMIN_DATABASE_URL_FILE must name'
    /** The edge stops on its missing admin URL. */
    private static readonly PlatformEdgeRefusal = 'PRAGMATIC_EDGE_ADMIN_URL must be'
    /** The gateway stops on its missing TLS files. */
    private static readonly EnvGatewayRefusal = 'are required for the gateway'
    private static readonly PlatformAdminDockerIgnore: readonly string[] = [
        '# Local dev data and generated seed secrets never enter the build context.',
        'src/data',
        'src/environments/*/data',
        'src/environments/*/master.key',
        'src/environments/*/provisioned-secrets.json',
        'src/environments/*/tenants.json',
        'src/environments/*/environments.json',
        'src/environments/*/realm-config.json',
        '**/*.log',
        '**/.superpowers',
        '**/playwright-report',
    ]
    private static readonly PlatformAdminGitIgnore: readonly string[] = [
        '# Generated by the local seed CLI and the console\'s dev data root: never committed (public repository).',
        'src/environments/*/master.key',
        'src/environments/*/provisioned-secrets.json',
        'src/environments/*/tenants.json',
        'src/environments/*/environments.json',
        'src/environments/*/realm-config.json',
        'src/environments/*/data/',
        '.superpowers/',
        'playwright-report/',
    ]
    private static readonly EnvServerDockerIgnore: readonly string[] = [
        '# Local dev secrets the compose files mount: never in the build context.',
        'docker/master.key',
        'docker/*.key',
        'docker/tls',
    ]
    private static readonly EnvServerGitIgnore: readonly string[] = [
        '# Local dev secrets the compose files mount (docker/README.md, docker/compose-README.md): never committed.',
        'docker/master.key',
        'docker/*.key',
        'docker/tls/',
    ]
    private static readonly TenantIdpDockerIgnore: readonly string[] = [
        '# Dev runs (tsx) write the IdP\'s keys and secrets into a data folder beside the sources: never in the build context.',
        'data',
        '**/data',
    ]
    private static readonly TenantIdpGitIgnore: readonly string[] = [
        '# Dev runs (tsx) write the IdP\'s keys and secrets into a data folder beside the sources.',
        'data/',
    ]

    private static readonly Profiles: ReadonlyMap<ReleaseApp, IContainerProfile> = new Map<ReleaseApp, IContainerProfile>([
        [ReleaseApp.PlatformAdmin, {
            Kind: ContainerKind.Node, MultiArch: true, AptPackages: ContainerProfiles.OpenSsl, ProvisioningTools: true,
            Env: [[ContainerProfiles.RoleVariable, ContainerProfiles.AdminRole]],
            Ports: [ContainerProfiles.AdminPort, ContainerProfiles.AdminInternalPort],
            Healthcheck: { Scheme: HealthScheme.Http, PortVariable: ContainerProfiles.AdminPortVariable, DefaultPort: ContainerProfiles.AdminPort },
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
            StartSmokeRefusal: ContainerProfiles.PlatformAdminRefusal,
            DockerIgnore: ContainerProfiles.PlatformAdminDockerIgnore, GitIgnore: ContainerProfiles.PlatformAdminGitIgnore,
        }],
        [ReleaseApp.PlatformEdge, {
            Kind: ContainerKind.Node, MultiArch: true, AptPackages: ContainerProfiles.None, ProvisioningTools: false,
            Env: [
                [ContainerProfiles.AgentChannelPortVariable, String(ContainerProfiles.AgentChannelPort)],
                [ContainerProfiles.AgentChannelBindVariable, ContainerProfiles.AllInterfaces],
            ],
            Ports: [ContainerProfiles.AgentChannelPort],
            Healthcheck: { Scheme: HealthScheme.Http, PortVariable: ContainerProfiles.AgentChannelPortVariable, DefaultPort: ContainerProfiles.AgentChannelPort },
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
            LegacyPeerDeps: true,
            StartSmokeRefusal: ContainerProfiles.PlatformEdgeRefusal,
        }],
        [ReleaseApp.EnvServer, {
            Kind: ContainerKind.Node, MultiArch: false, AptPackages: ContainerProfiles.None, ProvisioningTools: false,
            Env: [], Ports: [ContainerProfiles.HttpPort],
            Healthcheck: { Scheme: HealthScheme.Http, PortVariable: ContainerProfiles.HttpPortVariable, DefaultPort: ContainerProfiles.HttpPort },
            ImageTest: true, StartSmoke: true, HelmChart: ContainerProfiles.EnvServerChart, ClosureCheck: true, VersionManifest: ContainerProfiles.EnvServerManifest,
            DockerIgnore: ContainerProfiles.EnvServerDockerIgnore, GitIgnore: ContainerProfiles.EnvServerGitIgnore,
        }],
        [ReleaseApp.EnvGateway, {
            Kind: ContainerKind.Node, MultiArch: false, AptPackages: ContainerProfiles.None, ProvisioningTools: false,
            Env: [], Ports: [ContainerProfiles.HttpPort],
            Healthcheck: { Scheme: HealthScheme.Http, PortVariable: ContainerProfiles.HttpPortVariable, DefaultPort: ContainerProfiles.HttpPort },
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
            StartSmokeRefusal: ContainerProfiles.EnvGatewayRefusal,
        }],
        [ReleaseApp.HiveAgent, {
            Kind: ContainerKind.Node, MultiArch: false, AptPackages: ContainerProfiles.None, ProvisioningTools: false, Env: [], Ports: [],
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
        }],
        [ReleaseApp.TenantAdmin, {
            Kind: ContainerKind.Node, MultiArch: false, AptPackages: ContainerProfiles.None, ProvisioningTools: false, Env: [], Ports: [],
            Healthcheck: { Scheme: HealthScheme.Http, PortVariable: ContainerProfiles.TenantAdminPortVariable },
            ImageTest: true, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
        }],
        [ReleaseApp.TenantIdp, {
            Kind: ContainerKind.Node, MultiArch: true, AptPackages: ContainerProfiles.OpenSsl, ProvisioningTools: false, Env: [], Ports: [ContainerProfiles.IdpPort],
            Healthcheck: { Scheme: HealthScheme.Https, PortVariable: ContainerProfiles.IdpPortVariable, DefaultPort: ContainerProfiles.IdpPort, Insecure: true },
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
            DockerIgnore: ContainerProfiles.TenantIdpDockerIgnore, GitIgnore: ContainerProfiles.TenantIdpGitIgnore,
        }],
        [ReleaseApp.UiUnpack, {
            Kind: ContainerKind.Node, MultiArch: false, AptPackages: ContainerProfiles.None, ProvisioningTools: false, Env: [], Ports: [],
            ImageTest: false, StartSmoke: true, HelmChart: ContainerProfiles.NoChart, ClosureCheck: true, VersionManifest: ContainerProfiles.RootManifest,
        }],
        [ReleaseApp.Postgres, {
            Kind: ContainerKind.ExternalDockerfile, MultiArch: true, AptPackages: ContainerProfiles.None, ProvisioningTools: false, Env: [], Ports: [],
            ImageTest: true, StartSmoke: false, HelmChart: ContainerProfiles.NoChart, ClosureCheck: false, VersionManifest: ContainerProfiles.RootManifest,
        }],
    ])

    /** The profile of a release app; undefined for a name that is not one. */
    public static Of(app: ReleaseApp): IContainerProfile | undefined
    {
        return ContainerProfiles.Profiles.get(app)
    }
}
