import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import {
    CustomRealmSecrets,
    RealmSecretsHome,
    RealmSecretsOption,
    RealmSecretsSettings,
    RealmSecretsSettingsError,
    WorkloadContext,
    WorkloadContextError,
    type IRealmSecretsHomeFactory,
} from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { ComponentStartConfiguration, ConfigurationStartError, ConfigurationStartReason, type SecretStoreDirectory } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

/**
 * The four realm options' secrets homes. A cloud option's package (and its SDK) is loaded only when a realm uses it, so a
 * component on the custom option never loads the Google, Azure or AWS clients.
 */
export class RealmSecretsHomes
{
    /** The factory of `option`. */
    public static async Factory(option: RealmSecretsOption): Promise<IRealmSecretsHomeFactory>
    {
        switch (option)
        {
            case RealmSecretsOption.Custom:
                return new CustomRealmSecrets();
            case RealmSecretsOption.Gcp:
                return new (await import('@pragmatic-tech-ai/pragmatic-realm-gcp')).GcpWorkloadIdentity();
            case RealmSecretsOption.Azure:
                return new (await import('@pragmatic-tech-ai/pragmatic-realm-azure')).AzureWorkloadIdentity();
            case RealmSecretsOption.Aws:
                return new (await import('@pragmatic-tech-ai/pragmatic-realm-aws')).AwsWorkloadIdentity();
        }
    }

    /** A home holding the factory of `option` only. */
    public static async For(option: RealmSecretsOption): Promise<RealmSecretsHome>
    {
        return new RealmSecretsHome([await RealmSecretsHomes.Factory(option)]);
    }
}

/**
 * The secret stores a hive component resolves its configuration through: `file` (its mounted Secret) and, when the
 * engine chart names the realm's secrets option (`PRAGMATIC_REALM_SECRETS_OPTION` and the option's identifiers, with
 * the workload's `PRAGMATIC_REALM_ID`, `PRAGMATIC_COMPONENT` and `PRAGMATIC_WORKLOAD_TOKEN_FILE`), `realm`: the realm's
 * secrets home. Without an option the directory has `file` only, as before the realm secrets home (the realm sign-in
 * service then keeps its own `realm` store). Refused settings or an incomplete workload refuse the start as
 * `secrets-home-unavailable`; an unreachable home is found at the first reference it is asked for, with the same reason.
 */
export class RealmSecretsDirectory
{
    public static readonly RealmStore = 'realm';
    private static readonly Refused = "the realm's secrets home cannot be opened: ";

    /** `file` and, with a realm secrets option, `realm`. */
    public static async Stores(component: string, env: Readonly<Record<string, string | undefined>>, root?: string): Promise<SecretStoreDirectory>
    {
        const directory = ComponentStartConfiguration.Stores(component, root);
        const realm = await RealmSecretsDirectory.RealmStoreFor(component, env);
        if (realm !== undefined) directory.Add(RealmSecretsDirectory.RealmStore, realm);
        return directory;
    }

    /** Whether the environment names a realm secrets option. */
    public static Configured(env: Readonly<Record<string, string | undefined>>): boolean
    {
        const option = env[RealmSecretsSettings.OptionVariable];
        return option !== undefined && option !== '';
    }

    /** The realm's secrets home for this workload (for `realm` when given: the realm sign-in service serves several), or
     *  undefined when the environment names no realm secrets option. */
    public static async RealmStoreFor(component: string, env: Readonly<Record<string, string | undefined>>, realm?: string): Promise<ISecretStore | undefined>
    {
        try
        {
            const settings = RealmSecretsSettings.FromEnvironment(env);
            if (settings === undefined) return undefined;
            const context = WorkloadContext.FromEnvironment(env, component);
            const home = await RealmSecretsHomes.For(settings.Option);
            return await home.For(settings, realm === undefined ? context : context.ForRealm(realm));
        }
        catch (error)
        {
            if (error instanceof RealmSecretsSettingsError || error instanceof WorkloadContextError)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, RealmSecretsDirectory.Refused + error.message);
            }
            throw error;
        }
    }
}
