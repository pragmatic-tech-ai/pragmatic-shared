import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The ledger's internal API operations (each a `POST` under LedgerApiLink.BasePath). */
export enum LedgerOperation
{
    RegisterClient = 'register-client',
    MyClient = 'my-client',
    ListPlans = 'list-plans',
    StartCheckout = 'start-checkout',
    CancelSubscription = 'cancel-subscription',
}

/** The personal cabinet to ledger link over the mesh: its paths and the label its bearer is derived with. */
export class LedgerApiLink
{
    public static readonly BasePath = '/internal/ledger/v1/'
    public static readonly CredentialLabel = 'pragmatic-ledger-api/v1'
    public static readonly BodyLimit = 16384
    public static readonly Operations: readonly LedgerOperation[] = Object.values(LedgerOperation)

    public static PathOf(operation: LedgerOperation): string
    {
        return LedgerApiLink.BasePath + operation
    }

    public static CredentialFromFile(path: string): InternalApiCredential
    {
        return InternalApiCredential.FromFile(path, LedgerApiLink.CredentialLabel)
    }

    public static CredentialFromSecret(secret: Buffer): InternalApiCredential
    {
        return InternalApiCredential.FromSecret(secret, LedgerApiLink.CredentialLabel)
    }
}
