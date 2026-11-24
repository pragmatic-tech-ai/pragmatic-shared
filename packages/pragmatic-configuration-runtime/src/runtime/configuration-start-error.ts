/** Why a component refuses to start on its applied configuration. */
export enum ConfigurationStartReason
{
    Missing = 'missing',
    Unreadable = 'unreadable',
    Malformed = 'malformed',
    ComponentMismatch = 'component-mismatch',
    DescriptorMismatch = 'descriptor-mismatch',
    Invalid = 'invalid',
    /** A revalidating reader (the console's start) found an applied document of another descriptor that does not
     *  validate against its own even with the settings it no longer declares left behind. */
    Unrevalidated = 'unrevalidated',
    UnknownSecretStore = 'unknown-secret-store',
    SecretMissing = 'secret-missing',
    /** The resolved secrets could not be written to the component's secrets directory. */
    SecretsUnwritable = 'secrets-unwritable',
    /** A secret store failed to answer (other than "absent"), or cannot serve the reference's form. */
    SecretUnreadable = 'secret-unreadable',
    /** The realm's secrets home did not answer (its projected token, the token exchange, its permissions, its key or
     *  the home itself), or its settings are refused. The detail names the option and a code, never a cloud's text. */
    SecretsHomeUnavailable = 'secrets-home-unavailable',
}

/** The component cannot start on its applied configuration. The message says what to do; it names settings and secret
 *  references, never a secret value. */
export class ConfigurationStartError extends Error
{
    private static readonly Prefix = 'cannot start on the applied configuration';

    public constructor(public readonly Reason: ConfigurationStartReason, detail: string)
    {
        super(`${ConfigurationStartError.Prefix}: ${detail}`);
        this.name = ConfigurationStartError.name;
    }
}
