import {
    CustomRealmSecrets,
    RealmSecretsHome,
    RealmSecretsOption,
    RealmSecretsSettings,
    RealmSecretsSettingsError,
    SecretsHomeUnavailableError,
    WorkloadContext,
    WorkloadContextError,
    type IRealmSecretStore,
    type IRealmSecretsHomeFactory,
} from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { ComponentStartConfiguration, ConfigurationStartError, ConfigurationStartReason, type SecretStoreDirectory } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

/** Loads a cloud option's factory (its package and SDK). */
export interface IRealmSecretsOptionLoader
{
    Load(option: RealmSecretsOption): Promise<IRealmSecretsHomeFactory>;
}

/** The option packages, imported on first use. */
export class PackageRealmSecretsOptionLoader implements IRealmSecretsOptionLoader
{
    public async Load(option: RealmSecretsOption): Promise<IRealmSecretsHomeFactory>
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
}

/**
 * The four realm options' secrets homes. Every hive component can run on any option (the option is chosen when the hive
 * is installed), so the three cloud packages are dependencies of this package; each is loaded only when a realm uses it,
 * so a component on the custom option never loads the Google, Azure or AWS clients. A package that does not load refuses
 * the start as `secrets-home-unavailable`.
 */
export class RealmSecretsHomes
{
    private static readonly NotLoaded = "the realm secrets option's package could not be loaded: ";

    /** The factory of `option`. */
    public static async Factory(option: RealmSecretsOption, loader: IRealmSecretsOptionLoader = new PackageRealmSecretsOptionLoader()): Promise<IRealmSecretsHomeFactory>
    {
        try
        {
            return await loader.Load(option);
        }
        catch
        {
            throw new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, RealmSecretsHomes.NotLoaded + option);
        }
    }

    /** A home holding the factory of `option` only. */
    public static async For(option: RealmSecretsOption, loader?: IRealmSecretsOptionLoader): Promise<RealmSecretsHome>
    {
        return new RealmSecretsHome([await RealmSecretsHomes.Factory(option, loader)]);
    }
}

/**
 * The secret stores a hive component resolves its configuration through: `file` (its mounted Secret) and, when the
 * engine chart names the realm's secrets option (`PRAGMATIC_REALM_SECRETS_OPTION` and the option's identifiers, with
 * the workload's `PRAGMATIC_REALM_ID`, `PRAGMATIC_COMPONENT` and `PRAGMATIC_WORKLOAD_TOKEN_FILE`), `realm`: the realm's
 * secrets home. Without an option the directory has `file` only, as before the realm secrets home (the realm sign-in
 * service then keeps its own `realm` store). The home is verified when the directory is built (`IRealmSecretStore.Verify`:
 * the projected token is readable; the custom home's database answers for this role and its key check opens with the
 * mounted key), so a replaced master key refuses every component's start. Refused settings, an incomplete workload or a
 * home that fails its check refuse the start as `secrets-home-unavailable`; a cloud that does not answer is found at the
 * first reference it is asked for, with the same reason.
 */
export class RealmSecretsDirectory
{
    public static readonly RealmStore = 'realm';
    private static readonly Refused = "the realm's secrets home cannot be opened: ";
    private static readonly Unavailable = "the realm's secrets home is unavailable: ";
    private static readonly OptionOpen = '(';
    private static readonly OptionClose = ') ';

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
    public static async RealmStoreFor(component: string, env: Readonly<Record<string, string | undefined>>, realm?: string, loader?: IRealmSecretsOptionLoader): Promise<IRealmSecretStore | undefined>
    {
        try
        {
            const settings = RealmSecretsSettings.FromEnvironment(env);
            if (settings === undefined) return undefined;
            const context = WorkloadContext.FromEnvironment(env, component);
            const home = await RealmSecretsHomes.For(settings.Option, loader);
            const store = await home.For(settings, realm === undefined ? context : context.ForRealm(realm));
            await store.Verify();
            return store;
        }
        catch (error)
        {
            const D = RealmSecretsDirectory;
            if (error instanceof RealmSecretsSettingsError || error instanceof WorkloadContextError)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, D.Refused + error.message);
            }
            if (error instanceof SecretsHomeUnavailableError)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, D.Unavailable + D.OptionOpen + error.Option + D.OptionClose + error.Code);
            }
            throw error;
        }
    }
}
