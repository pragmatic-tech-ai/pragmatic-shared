import { RealmSecretsOption } from './realm-secrets-option.js'

/**
 * The identifier names each cloud option's secrets home takes (RealmSecretsSettings names): the one home of the lists, so
 * the option packages' rules (each asserts its own `Settings` names equal these) and whoever passes settings on (the
 * console to its environments) cannot drift apart. The custom option takes file paths, not identifiers: none here.
 */
export class RealmSecretsIdentifiers
{
    public static readonly Gcp: readonly string[] = Object.freeze(['projectId', 'workloadIdentityAudience', 'serviceAccountEmail', 'replicaLocation'])
    public static readonly Azure: readonly string[] = Object.freeze(['tenantId', 'clientId', 'vaultUrl', 'authorityHost'])
    public static readonly Aws: readonly string[] = Object.freeze(['region', 'roleArn', 'sessionName'])
    private static readonly None: readonly string[] = Object.freeze([])

    private constructor()
    {
    }

    /** The identifier names of `option` (none for custom). */
    public static Of(option: RealmSecretsOption): readonly string[]
    {
        const I = RealmSecretsIdentifiers
        switch (option)
        {
            case RealmSecretsOption.Gcp:
                return I.Gcp
            case RealmSecretsOption.Azure:
                return I.Azure
            case RealmSecretsOption.Aws:
                return I.Aws
            default:
                return I.None
        }
    }
}
