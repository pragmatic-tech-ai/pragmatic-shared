import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The ledger to platform admin console link: its one route and the label its bearer is derived with. */
export class EntitlementsLink
{
    public static readonly StatementsPath = '/internal/entitlements/v1/statements'
    public static readonly CredentialLabel = 'pragmatic-entitlements/v1'
    public static readonly BodyLimit = 65536

    /** The link credential from the shared secret file both ends read. */
    public static CredentialFromFile(path: string): InternalApiCredential
    {
        return InternalApiCredential.FromFile(path, EntitlementsLink.CredentialLabel)
    }

    public static CredentialFromSecret(secret: Buffer): InternalApiCredential
    {
        return InternalApiCredential.FromSecret(secret, EntitlementsLink.CredentialLabel)
    }
}
