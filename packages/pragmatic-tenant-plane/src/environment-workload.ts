import { randomBytes } from 'node:crypto'
import { BundleBuilder } from './seed/bundle.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { HiveRecord } from './platform-records.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { InClusterRegistry } from './in-cluster-registry.js'
import type { IngressTls } from './ingress-tls.js'
import { TemplateCatalog } from './template-catalog.js'

/** A provisioned Postgres sidecar; the password is referenced by secret name only. */
export type WorkloadDatabase = {
    image: string
    user: string
    database: string
    passwordRef: string
}

/**
 * The env server's own Postgres (every record it keeps lives there): the pragmatic-postgres image run beside the server in its
 * pod (reachable on the pod's loopback only), its data in the environment's data claim, and the Secret (in the environment
 * namespace) holding the superuser password, the server role's password and the server's database URL (keys
 * EnvironmentDatabaseSecret.*). Not the template's data-source database (WorkloadDatabase).
 */
export type WorkloadServerDatabase = {
    /** Mapped to the hive's registry, verified and signed exactly like the server `image` (EnvironmentWorkloadFactory.ImagesOf). */
    image: string
    secretName: string
}

/** The keys of an environment's server database Secret and what its Postgres creates: the one home of their names. */
export class EnvironmentDatabaseSecret
{
    public static readonly SuperuserKey = 'superuser'
    public static readonly PasswordKey = 'password'
    public static readonly UrlKey = 'database-url'
    /** The application (the env server's component name), database and role its Postgres creates. */
    public static readonly Application = 'pragmatic-env-server'
    public static readonly Database = 'env_server'
    public static readonly Role = 'env_server'
    public static readonly Host = '127.0.0.1'
    public static readonly Port = 5432
    /** The pragmatic-postgres image a development cluster runs (docker/postgres, loaded into kind), as the IdP's. */
    public static readonly DevImage = 'pragmatic-postgres:local'
    private static readonly NameSuffix = '-postgres'
    private static readonly UrlScheme = 'postgres://'
    private static readonly UserSeparator = ':'
    private static readonly HostSeparator = '@'
    private static readonly PathSeparator = '/'
    private static readonly Space = ' '
    private static readonly PasswordBytes = 24
    private static readonly PasswordEncoding = 'base64url'
    private static readonly Utf8 = 'utf8'

    /** The environment's server database Secret (`<env>-postgres`, like `<env>-env-secrets`); also its applications ConfigMap. */
    public static NameOf(environmentName: string): string
    {
        return environmentName + EnvironmentDatabaseSecret.NameSuffix
    }

    /** The env server's database URL for a role password (on the loopback its Postgres shares with it). */
    public static UrlOf(password: string): string
    {
        const S = EnvironmentDatabaseSecret
        return S.UrlScheme + S.Role + S.UserSeparator + encodeURIComponent(password) + S.HostSeparator + S.Host + S.UserSeparator + String(S.Port) + S.PathSeparator + S.Database
    }

    /** The pragmatic-postgres applications.conf line. */
    public static ApplicationsLine(): string
    {
        const S = EnvironmentDatabaseSecret
        return [S.Application, S.Database, S.Role].join(S.Space)
    }

    /** A random database password (URL-safe, so the URL needs no escaping). */
    public static NewPassword(): string
    {
        return randomBytes(EnvironmentDatabaseSecret.PasswordBytes).toString(EnvironmentDatabaseSecret.PasswordEncoding)
    }

    /** Fresh Secret data: a superuser password, the server role's password and the URL that carries it. */
    public static Mint(): Map<string, Buffer>
    {
        const S = EnvironmentDatabaseSecret
        const password = S.NewPassword()
        return new Map<string, Buffer>([
            [S.SuperuserKey, Buffer.from(S.NewPassword(), S.Utf8)],
            [S.PasswordKey, Buffer.from(password, S.Utf8)],
            [S.UrlKey, Buffer.from(S.UrlOf(password), S.Utf8)],
        ])
    }
}

/** In-cluster OIDC federation of a served environment: its browser host base domain and the ca.crt-only Secret it trusts the IdP through. */
export type WorkloadFederation = {
    baseDomain: string
    /** Secret holding ONLY the public CA certificate (key ca.crt); never the IdP server key. */
    caSecretName: string
    /** The console's Ingress TLS choice; absent -> the controller's default certificate. */
    ingressTls?: IngressTls
}

/** The app artifact an environment's pod pulls and verifies: registry coordinates, pinned digest, and the trust Secret/key it verifies against. */
export type WorkloadAppDeployment = {
    appName: string
    appVersion: string
    registryPullBase: string
    repo: string
    artifactTag: string
    manifestDigest: string
    trustSecretName: string
    /** The hive's trust-root reference; empty when the hive has none (the actuator enforces presence). */
    trustKeyRef: string
    /** The image the `ui-unpack` init container runs (pragmatic-ui-unpack, by its ENTRYPOINT); mapped and verified like `image`. */
    unpackImage: string
}

/** Backend-neutral description of what to run for one environment. Carries secret names, never values. */
export type EnvironmentWorkload = {
    environmentName: string
    /** The id the server reads its data dir by (data/<environmentId>/); differs from the name for e.g. Demo envs. */
    environmentId: string
    hiveId: string
    image: string
    serverPort: number
    env: Readonly<Record<string, string>>
    secretRefs: readonly string[]
    /** The env server's own Postgres (always: the server keeps every record there). */
    serverDatabase: WorkloadServerDatabase
    database?: WorkloadDatabase
    federation?: WorkloadFederation
    appDeployment?: WorkloadAppDeployment
}

export class EnvironmentWorkloadFactory
{
    /** The env server image every environment runs, named like each container repository's dev build (`<app>:dev`). */
    public static readonly ServerImage = 'pragmatic-env-server:dev'
    /** The UI unpack image an app deployment's init container runs, named like the server image (a hive-local dev build). */
    public static readonly UiUnpackImage = 'pragmatic-ui-unpack:dev'
    private static readonly DatabaseImage = 'postgres:16'
    /** The env server's container + Service port. */
    public static readonly ServerPort = 8080
    private static readonly NoTrustKeyRef = ''
    /** The in-cluster registry is plain HTTP; the pod-side client needs an absolute URL base. */
    private static readonly HttpScheme = 'http://'
    private static readonly PortEnvKey = 'PRAGMATIC_PORT'

    /**
     * Database presence follows the real template definition (TemplateCatalog.Resolve), so it cannot drift from the docker model.
     * `serverDatabaseImage` is the pragmatic-postgres image of the server's sidecar: a released platform passes its release's
     * image, a development box keeps EnvironmentDatabaseSecret.DevImage (loaded into kind like the server's dev image).
     */
    public static From(record: EnvironmentRecord, hive: HiveRecord, ingressTls?: IngressTls, serverDatabaseImage: string = EnvironmentDatabaseSecret.DevImage): EnvironmentWorkload
    {
        const type = record.type ?? TemplateCatalog.DefaultTypeFor(record.template)
        const def = TemplateCatalog.Resolve(record.template, record.name, record.hostPort as number, type, true).def
        const secretRefs = [def.environmentId + BundleBuilder.AdminSecretSuffix]
        const workload: EnvironmentWorkload = {
            environmentName: record.name,
            environmentId: def.environmentId,
            hiveId: hive.id,
            image: EnvironmentWorkloadFactory.ServerImage,
            serverPort: EnvironmentWorkloadFactory.ServerPort,
            env: { [EnvironmentWorkloadFactory.PortEnvKey]: String(EnvironmentWorkloadFactory.ServerPort) },
            secretRefs,
            serverDatabase: { image: serverDatabaseImage, secretName: EnvironmentDatabaseSecret.NameOf(record.name) },
        }
        if (def.database)
        {
            const passwordRef = BundleBuilder.DbSecretRef(def, def.database)
            secretRefs.push(passwordRef)
            workload.database = {
                image: EnvironmentWorkloadFactory.DatabaseImage,
                user: def.database.user,
                database: def.database.database,
                passwordRef,
            }
        }
        if (record.idpBaseDomain !== undefined)
        {
            workload.federation = { baseDomain: record.idpBaseDomain, caSecretName: EnvServerSeedSource.IdpCaSecretNameOf(record.name) }
            if (ingressTls !== undefined)
            {
                workload.federation.ingressTls = ingressTls
            }
        }
        if (record.appDeployment !== undefined)
        {
            workload.appDeployment = {
                appName: record.appDeployment.appName,
                appVersion: record.appDeployment.appVersion,
                registryPullBase: EnvironmentWorkloadFactory.HttpScheme + InClusterRegistry.PullBase(),
                repo: record.appDeployment.repo,
                artifactTag: record.appDeployment.artifactTag,
                manifestDigest: record.appDeployment.manifestDigest,
                trustSecretName: EnvServerSeedSource.UiTrustSecretNameOf(record.name),
                trustKeyRef: hive.trustRootRef ?? EnvironmentWorkloadFactory.NoTrustKeyRef,
                unpackImage: EnvironmentWorkloadFactory.UiUnpackImage,
            }
        }
        return workload
    }

    /**
     * Every image the workload's pod runs from the platform: the server, its pragmatic-postgres sidecar and, with an app
     * deployment, the UI unpacker. Each is mapped to the hive's registry, verified, signed and (on kind) loaded alike.
     */
    public static ImagesOf(workload: EnvironmentWorkload): string[]
    {
        const images = [workload.image, workload.serverDatabase.image]
        if (workload.appDeployment !== undefined)
        {
            images.push(workload.appDeployment.unpackImage)
        }
        return images
    }

    /** The workload with every platform image (ImagesOf) replaced by `map(image)`, in ImagesOf's order. */
    public static async WithImages(workload: EnvironmentWorkload, map: (image: string) => Promise<string>): Promise<EnvironmentWorkload>
    {
        const image = await map(workload.image)
        const serverDatabase = { ...workload.serverDatabase, image: await map(workload.serverDatabase.image) }
        const mapped: EnvironmentWorkload = { ...workload, image, serverDatabase }
        if (workload.appDeployment !== undefined)
        {
            mapped.appDeployment = { ...workload.appDeployment, unpackImage: await map(workload.appDeployment.unpackImage) }
        }
        return mapped
    }
}
