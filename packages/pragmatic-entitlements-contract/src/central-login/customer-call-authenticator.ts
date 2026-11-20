import type { IncomingHttpHeaders } from 'node:http'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { CentralLoginSubject } from './central-login-subject.js'
import type { ICentralLoginVerifier } from './central-login-verifier.js'

/** What authenticating an internal customer call found. */
export enum CustomerCallOutcome
{
    /** The caller service's bearer is missing or wrong. */
    Unauthorized = 'unauthorized',
    /** The service is right but the customer's token is missing or not valid. */
    NotSignedIn = 'not-signed-in',
    Accepted = 'accepted',
}

export class CustomerCallResult
{
    public constructor(public readonly Outcome: CustomerCallOutcome, public readonly Customer: CentralLoginSubject | undefined)
    {
    }
}

/**
 * Authenticates a call that a service makes over an internal link on behalf of a signed-in customer (the personal
 * cabinet to the ledger, the edge to the platform admin console): the link's bearer in `authorization`, and the
 * customer's own central-login token in `x-pragmatic-customer-token`, which the receiving server verifies itself, so a
 * compromised caller service cannot act for a customer whose token it does not hold.
 */
export class CustomerCallAuthenticator
{
    public static readonly TokenHeader = 'x-pragmatic-customer-token'
    public static readonly MaxTokenLength = 16384
    private static readonly AuthorizationHeader = 'authorization'

    public constructor(private readonly credential: InternalApiCredential, private readonly verifier: ICentralLoginVerifier)
    {
    }

    /** The headers a calling service sends: its bearer, and the customer's token when there is one. */
    public static Headers(credential: InternalApiCredential, customerToken: string | undefined): Record<string, string>
    {
        const headers: Record<string, string> = { [CustomerCallAuthenticator.AuthorizationHeader]: credential.AuthorizationValue() }
        if (customerToken !== undefined)
        {
            headers[CustomerCallAuthenticator.TokenHeader] = customerToken
        }
        return headers
    }

    /** `requireCustomer` false: only the service is checked (a call made for nobody in particular, e.g. list plans). */
    public async Authenticate(headers: IncomingHttpHeaders, requireCustomer: boolean): Promise<CustomerCallResult>
    {
        const authorization = headers[CustomerCallAuthenticator.AuthorizationHeader]
        if (!this.credential.MatchesAuthorization(typeof authorization === 'string' ? authorization : undefined))
        {
            return new CustomerCallResult(CustomerCallOutcome.Unauthorized, undefined)
        }
        if (!requireCustomer)
        {
            return new CustomerCallResult(CustomerCallOutcome.Accepted, undefined)
        }
        const token = headers[CustomerCallAuthenticator.TokenHeader]
        if (typeof token !== 'string' || token.length === 0 || token.length > CustomerCallAuthenticator.MaxTokenLength)
        {
            return new CustomerCallResult(CustomerCallOutcome.NotSignedIn, undefined)
        }
        const customer = await this.verifier.Verify(token)
        return customer === undefined
            ? new CustomerCallResult(CustomerCallOutcome.NotSignedIn, undefined)
            : new CustomerCallResult(CustomerCallOutcome.Accepted, customer)
    }
}
