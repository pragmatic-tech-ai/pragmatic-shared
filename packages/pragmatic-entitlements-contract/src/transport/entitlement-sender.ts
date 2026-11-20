import { JsonPostClient, JsonPostUnavailableError, JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { EntitlementStatement } from '../statement/entitlement-statement.js'
import { EntitlementReceipt } from './entitlement-receipt.js'
import { EntitlementsLink } from './entitlements-link.js'

/** A statement was not taken: the receiver is unreachable (`unavailable`), or it refused (its status and code). The
 *  ledger keeps the statement and resends it later; the message carries no response text. */
export class EntitlementDeliveryError extends Error
{
    public static readonly UnavailableCode = 'unavailable'
    private static readonly ErrorName = 'EntitlementDeliveryError'
    private static readonly MessagePrefix = 'entitlement statement not delivered: '

    public constructor(public readonly Status: number, public readonly Code: string)
    {
        super(EntitlementDeliveryError.MessagePrefix + Code)
        this.name = EntitlementDeliveryError.ErrorName
    }
}

/** The ledger's side: sends one statement to the platform admin console and returns its receipt. Retrying is the
 *  ledger's (an outbox), not this class's. */
export class EntitlementSender
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly CodeField = 'code'
    private static readonly UnknownCode = 'refused'

    private readonly client: JsonPostClient

    public constructor(baseUrl: string, private readonly credential: InternalApiCredential, timeoutMs: number = JsonPostClient.DefaultTimeoutMs)
    {
        this.client = new JsonPostClient(baseUrl, timeoutMs)
    }

    public async Send(statement: EntitlementStatement): Promise<EntitlementReceipt>
    {
        let reply
        try
        {
            reply = await this.client.Post(EntitlementsLink.StatementsPath, statement.ToJson(), { [EntitlementSender.AuthorizationHeader]: this.credential.AuthorizationValue() })
        }
        catch (err)
        {
            if (err instanceof JsonPostUnavailableError)
            {
                throw new EntitlementDeliveryError(0, EntitlementDeliveryError.UnavailableCode)
            }
            throw err
        }
        if (!reply.Ok)
        {
            throw new EntitlementDeliveryError(reply.Status, EntitlementSender.CodeOf(reply.Body))
        }
        try
        {
            return EntitlementReceipt.Parse(reply.Body)
        }
        catch
        {
            throw new EntitlementDeliveryError(reply.Status, EntitlementDeliveryError.UnavailableCode)
        }
    }

    private static CodeOf(body: unknown): string
    {
        const code = JsonFields.IsObject(body) ? body[EntitlementSender.CodeField] : undefined
        return typeof code === 'string' ? code : EntitlementSender.UnknownCode
    }
}
