import type { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import { SecretValue } from './secret-value.js';

/** Where a secret is read from: any `ISecretStore` of pragmatic-identity fits (only `Get` is used). */
export interface ISecretSource
{
    /** Null when absent; never throws for absence. */
    Get(reference: string): Promise<string | null>;
}

/**
 * The realm's secrets home as a component sees it: its secret stores by the store name a `SecretReference` carries
 * (`secret:<store>/<name>[@<version>]`). A reference resolves by asking that store for `<name>`, or `<name>@<version>`
 * when the reference pins a version.
 */
export class SecretStoreDirectory
{
    private static readonly StorePattern = /^[a-z0-9][a-z0-9-]*$/;
    private static readonly VersionSeparator = '@';
    private static readonly BadName = 'a secret store name is lowercase letters, digits and "-"';
    private static readonly Duplicate = 'a secret store is already registered under';
    private static readonly UnknownError = 'unknown error';
    private static readonly Refers = ' refers to ';
    private static readonly NoStorePrefix = ", but no secret store '";
    private static readonly NoStoreSuffix = "' is available to this component";
    private static readonly UnreadableInfix = ', which its store could not read: ';
    private static readonly NotHeld = ", which the realm's secrets home does not hold";
    private static readonly HomeUnavailable = ", but the realm's secrets home is unavailable: ";
    private static readonly OptionOpen = '(';
    private static readonly OptionClose = ') ';
    private static readonly NoOption = '';
    /** The error name pragmatic-realm-adapters' `SecretsHomeUnavailableError` carries (this package does not depend on it). */
    public static readonly HomeUnavailableErrorName = 'SecretsHomeUnavailableError';

    private readonly stores = new Map<string, ISecretSource>();

    public Add(name: string, store: ISecretSource): SecretStoreDirectory
    {
        if (!SecretStoreDirectory.StorePattern.test(name)) throw new Error(SecretStoreDirectory.BadName);
        if (this.stores.has(name)) throw new Error(`${SecretStoreDirectory.Duplicate} '${name}'`);
        this.stores.set(name, store);
        return this;
    }

    /** The key the reference's store is asked for. */
    public static KeyOf(reference: SecretReference): string
    {
        return reference.Version === undefined ? reference.Name : reference.Name + SecretStoreDirectory.VersionSeparator + reference.Version;
    }

    /** The secret behind `reference`, for the setting `where` (used in errors only). */
    public async Resolve(reference: SecretReference, where: string): Promise<SecretValue>
    {
        const S = SecretStoreDirectory;
        const store = this.stores.get(reference.Store);
        if (store === undefined)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.UnknownSecretStore, `${where}${S.Refers}${reference.Format()}${S.NoStorePrefix}${reference.Store}${S.NoStoreSuffix}`);
        }
        let value: string | null;
        try
        {
            value = await store.Get(SecretStoreDirectory.KeyOf(reference));
        }
        catch (error)
        {
            if (error instanceof ConfigurationStartError) throw error;
            if ((error as { name?: unknown } | null)?.name === S.HomeUnavailableErrorName)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.SecretsHomeUnavailable, `${where}${S.Refers}${reference.Format()}${S.HomeUnavailable}${S.OptionOf(error)}${S.CodeOf(error)}`);
            }
            throw new ConfigurationStartError(ConfigurationStartReason.SecretUnreadable, `${where}${S.Refers}${reference.Format()}${S.UnreadableInfix}${S.CodeOf(error)}`);
        }
        if (value === null)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.SecretMissing, `${where}${S.Refers}${reference.Format()}${S.NotHeld}`);
        }
        return new SecretValue(value);
    }

    // `(<option>) ` of a secrets home's error, when it names one (a fixed word: custom, gcp, azure, aws).
    private static OptionOf(error: unknown): string
    {
        const option = (error as { Option?: unknown }).Option;
        const S = SecretStoreDirectory;
        return typeof option === 'string' && S.StorePattern.test(option) ? S.OptionOpen + option + S.OptionClose : S.NoOption;
    }

    // The error's code or name only: a store's message could carry what it read.
    private static CodeOf(error: unknown): string
    {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : error instanceof Error ? error.name : SecretStoreDirectory.UnknownError;
    }
}
