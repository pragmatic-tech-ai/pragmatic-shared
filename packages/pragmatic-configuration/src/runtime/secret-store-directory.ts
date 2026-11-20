import type { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import { SecretValue } from './secret-value.js';

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

    private readonly stores = new Map<string, ISecretStore>();

    public Add(name: string, store: ISecretStore): SecretStoreDirectory
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
        const store = this.stores.get(reference.Store);
        if (store === undefined)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.UnknownSecretStore, `${where} refers to ${reference.Format()}, but no secret store '${reference.Store}' is available to this component`);
        }
        const value = await store.Get(SecretStoreDirectory.KeyOf(reference));
        if (value === null)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.SecretMissing, `${where} refers to ${reference.Format()}, which the realm's secrets home does not hold`);
        }
        return new SecretValue(value);
    }
}
