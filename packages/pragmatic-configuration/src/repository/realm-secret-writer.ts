import { SecretReference } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { RealmSecretName } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { RealmSecretsDirectory } from '../runtime/realm-secrets-directory.js';

/** The environment names no realm secrets option, so there is no realm secrets home to write to. */
export class NoRealmSecretsHomeError extends Error
{
    public static readonly ErrorName = 'NoRealmSecretsHomeError';
    private static readonly Message = 'this hive has no realm secrets home (PRAGMATIC_REALM_SECRETS_OPTION is not set)';

    public constructor()
    {
        super(NoRealmSecretsHomeError.Message);
        this.name = NoRealmSecretsHomeError.ErrorName;
    }
}

/**
 * The tenant admin console's write path into the realm's secrets home: a value a tenant admin enters is stored under its
 * name and the configuration keeps only the reference `secret:realm/<name>`. Cloud homes are written with the console's
 * own workload identity, the custom home through the console's writer role. The value is never echoed, logged or
 * returned; failures are the home's typed errors (`SecretsHomeUnavailableError`), whose text names a code only.
 */
export class RealmSecretWriter
{
    public constructor(private readonly home: ISecretStore)
    {
    }

    /** The console's writer, from the environment the engine chart sets; the home is verified first (a replaced master key
     *  refuses the console's start, ConfigurationStartError `secrets-home-unavailable`). */
    public static async FromEnvironment(component: string, env: Readonly<Record<string, string | undefined>>): Promise<RealmSecretWriter>
    {
        const home = await RealmSecretsDirectory.RealmStoreFor(component, env);
        if (home === undefined) throw new NoRealmSecretsHomeError();
        return new RealmSecretWriter(home);
    }

    /** Stores `value` as the realm secret `name` (a new version where the home keeps versions); answers its reference. */
    public async Put(name: string, value: string): Promise<SecretReference>
    {
        const checked = RealmSecretName.ForWrite(name);
        await this.home.Put(checked.Name, value);
        return new SecretReference(RealmSecretsDirectory.RealmStore, checked.Name);
    }

    /** Whether the home holds `name` (its latest version); the value itself is not returned. */
    public async Holds(name: string): Promise<boolean>
    {
        return (await this.home.Get(RealmSecretName.ForWrite(name).Name)) !== null;
    }

    /** Deletes the realm secret `name`. Where a cloud keeps deleted secrets recoverable (a Key Vault this identity may not
     *  purge) it stays recoverable for the vault's retention, and a later write of that name brings it back first. */
    public async Delete(name: string): Promise<void>
    {
        await this.home.Delete(RealmSecretName.ForWrite(name).Name);
    }
}
