/** A realm's option, as far as its secrets home goes: where the realm's secrets live. */
export enum RealmSecretsOption
{
    /** An encrypted store in the hive's own `pragmatic-postgres` (database `realm_secrets`). */
    Custom = 'custom',
    /** Google Secret Manager, reached by workload identity federation. */
    Gcp = 'gcp',
    /** Azure Key Vault, reached by Entra workload identity. */
    Azure = 'azure',
    /** AWS Secrets Manager, reached by web-identity role assumption. */
    Aws = 'aws',
}

/** The options, for parsing. */
export class RealmSecretsOptions
{
    public static readonly All: readonly RealmSecretsOption[] = Object.values(RealmSecretsOption)

    public static Parse(text: string): RealmSecretsOption | undefined
    {
        return RealmSecretsOptions.All.find(option => option === text)
    }
}
