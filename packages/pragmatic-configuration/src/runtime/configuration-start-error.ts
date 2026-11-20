/** Why a component refuses to start on its applied configuration. */
export enum ConfigurationStartReason
{
    Missing = 'missing',
    Unreadable = 'unreadable',
    Malformed = 'malformed',
    ComponentMismatch = 'component-mismatch',
    DescriptorMismatch = 'descriptor-mismatch',
    Invalid = 'invalid',
    UnknownSecretStore = 'unknown-secret-store',
    SecretMissing = 'secret-missing',
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
