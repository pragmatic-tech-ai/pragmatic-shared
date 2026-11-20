import { JsonPostClient, JsonPostUnavailableError, JsonReply } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiLink } from '../customer-api-link.js'
import type { CustomerOperation } from '../customer-api-link.js'
import { CustomerApiError, CustomerErrorCode } from '../errors/customer-api-error.js'

/**
 * The platform edge's part: a public `POST` to one of the customer API's public paths is relayed to the platform
 * admin console's internal path with the link bearer, the customer's own token moved to `x-pragmatic-customer-token`
 * (the edge never verifies or keeps it: the console does), and the console's answer handed back verbatim. The edge
 * reads the body under its own limit; the relay never sends a call without a customer bearer.
 */
export class CustomerApiRelay
{
    private static readonly MethodPost = 'POST'
    private static readonly ErrorField = 'error'
    private static readonly BearerPattern = /^Bearer (\S+)$/

    private readonly client: JsonPostClient

    public constructor(adminBaseUrl: string, private readonly credential: InternalApiCredential, timeoutMs: number = JsonPostClient.DefaultTimeoutMs)
    {
        this.client = new JsonPostClient(adminBaseUrl, timeoutMs)
    }

    /** The operation a public request names, when it is one the relay carries. */
    public OperationOf(method: string | undefined, path: string): CustomerOperation | undefined
    {
        return method?.toUpperCase() === CustomerApiRelay.MethodPost ? CustomerApiLink.OperationOfPublicPath(path) : undefined
    }

    /** `authorization`: the public request's header. Answers `not-signed-in` without a bearer, `unavailable` when the
     *  console does not answer, else the console's own answer. */
    public async Relay(operation: CustomerOperation, authorization: string | undefined, body: unknown): Promise<JsonReply>
    {
        const match = authorization === undefined ? null : CustomerApiRelay.BearerPattern.exec(authorization)
        const token = match === null ? undefined : match[1] as string
        if (token === undefined || token.length > CustomerCallAuthenticator.MaxTokenLength)
        {
            return CustomerApiRelay.Refusal(CustomerErrorCode.NotSignedIn)
        }
        try
        {
            return await this.client.Post(CustomerApiLink.InternalPathOf(operation), body, CustomerCallAuthenticator.Headers(this.credential, token))
        }
        catch (err)
        {
            if (err instanceof JsonPostUnavailableError)
            {
                return CustomerApiRelay.Refusal(CustomerErrorCode.Unavailable)
            }
            throw err
        }
    }

    private static Refusal(code: CustomerErrorCode): JsonReply
    {
        const error = new CustomerApiError(code)
        return new JsonReply(error.Status, { ...error.Fields(), [CustomerApiRelay.ErrorField]: error.message })
    }
}
