import type { IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { EnvironmentHiveDatabase } from './environment-workload.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'

/**
 * Provisions environments on the hive's one `pragmatic-postgres` (a chart-installed management engine): the console's
 * superuser session (tenant-admin's HivePostgresProvisioner) implements it. Declared here, free of any console type, so the
 * in-cluster runtime can call it without knowing who provisions.
 */
export interface IEnvironmentDatabaseProvisioner
{
    /** Creates the environment's role and database once and sets the role's password to `password`; idempotent, safe to retry. */
    Ensure(environmentName: string, password: string): Promise<void>
    /** Drops the environment's database and role; only on the environment's deletion. */
    Drop(environmentName: string): Promise<void>
}

/** A chart-installed environment was brought up by a console that has no hive Postgres to provision it on. */
export class HiveDatabaseUnavailableError extends Error
{
    private static readonly DefaultMessage = 'This console has no hive Postgres to provision the environment database on.'
    private static readonly ErrorName = 'HiveDatabaseUnavailableError'

    public constructor()
    {
        super(HiveDatabaseUnavailableError.DefaultMessage)
        this.name = HiveDatabaseUnavailableError.ErrorName
    }
}

/**
 * The environment's database Secret `<env>-database` (`password`, `database-url`) in its namespace, kept beside the role on
 * the hive Postgres. Its password is the one truth: a bring-up reads it (or mints one when the Secret is absent), sets the
 * role to it, then creates the Secret only when absent, so a retry, a restart or a lost race never rotates the password the
 * running server holds.
 */
export class EnvironmentHiveDatabaseSecret
{
    private static readonly SecretResourcePrefix = 'secret/'
    private static readonly ApiVersion = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly OpaqueType = 'Opaque'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly TypeKey = 'type'
    private static readonly DataKey = 'data'

    private constructor()
    {
    }

    public static async Ensure(kubectl: IKubectl, environmentName: string, provisioner: IEnvironmentDatabaseProvisioner): Promise<void>
    {
        const S = EnvironmentHiveDatabaseSecret
        const stored = await S.PasswordOf(kubectl, environmentName)
        const password = stored ?? EnvironmentHiveDatabase.NewPassword()
        await provisioner.Ensure(environmentName, password)
        if (stored !== undefined)
        {
            return
        }
        if (!await kubectl.Create(S.ManifestOf(environmentName, password)))
        {
            // Another bring-up created it meanwhile: its password wins, so the role is set to it again.
            const theirs = await S.PasswordOf(kubectl, environmentName)
            if (theirs !== undefined)
            {
                await provisioner.Ensure(environmentName, theirs)
            }
        }
    }

    /** The stored role password, or undefined when the Secret (or its key) is absent. */
    private static async PasswordOf(kubectl: IKubectl, environmentName: string): Promise<string | undefined>
    {
        const S = EnvironmentHiveDatabaseSecret
        const raw = await kubectl.Find(K8sManifestBuilder.NamespaceOf(environmentName), S.SecretResourcePrefix + EnvironmentHiveDatabase.SecretNameOf(environmentName))
        if (raw === undefined)
        {
            return undefined
        }
        const encoded = (JSON.parse(raw) as { data?: Record<string, string> }).data?.[EnvironmentHiveDatabase.PasswordKey]
        return encoded === undefined || encoded === '' ? undefined : Buffer.from(encoded, S.Base64).toString(S.Utf8)
    }

    /** The Secret's manifest; it goes only to kubectl's create (no last-applied annotation carries it). */
    private static ManifestOf(environmentName: string, password: string): string
    {
        const S = EnvironmentHiveDatabaseSecret
        const E = EnvironmentHiveDatabase
        return JSON.stringify({
            [S.ApiVersionKey]: S.ApiVersion,
            [S.KindKey]: S.SecretKind,
            [S.MetadataKey]: { [S.NameKey]: E.SecretNameOf(environmentName), [S.NamespaceKey]: K8sManifestBuilder.NamespaceOf(environmentName) },
            [S.TypeKey]: S.OpaqueType,
            [S.DataKey]: {
                [E.PasswordKey]: Buffer.from(password, S.Utf8).toString(S.Base64),
                [E.UrlKey]: Buffer.from(E.UrlOf(environmentName, password), S.Utf8).toString(S.Base64),
            },
        })
    }
}
