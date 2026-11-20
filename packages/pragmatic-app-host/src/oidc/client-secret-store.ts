import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'

/** The one-secret ISecretStore the OIDC authenticator reads a client's secret from, for the length of one exchange. */
export class ClientSecretStore implements ISecretStore
{
    public static readonly Reference = 'oidc-client-secret'
    private static readonly ReadOnlyMessage = 'ClientSecretStore is read-only'

    public constructor(private readonly secret: string)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        return reference === ClientSecretStore.Reference ? this.secret : null
    }

    public async Put(): Promise<void>
    {
        throw new Error(ClientSecretStore.ReadOnlyMessage)
    }

    public async Delete(): Promise<void>
    {
        throw new Error(ClientSecretStore.ReadOnlyMessage)
    }
}
