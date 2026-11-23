import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { HttpMethod, RouteAuth } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { RequestContext } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerApiLink, CustomerOperation } from '../customer-api-link.js'
import { CustomerApiClient } from '../transport/customer-api-client.js'
import { CustomerApiError, CustomerErrorCode, CustomerErrorCodes } from '../errors/customer-api-error.js'
import { ListTenantsRequest } from '../dto/tenant.js'
import { LeaveHiveRequest, ListHivesRequest } from '../dto/hive.js'
import { ContractHost } from './support/contract-host.js'

/** A stand-in platform edge answering each public path with one of its own refusals. */
class RefusingEdge
{
    public static readonly RetryAfterHeader = 'Retry-After'
    public static readonly RetryAfterSeconds = 7
    public static readonly Token = 'alice-token'
    public static readonly Refusals: ReadonlyMap<CustomerOperation, CustomerErrorCode> = new Map([
        [CustomerOperation.ListTenants, CustomerErrorCode.RateLimited],
        [CustomerOperation.ListHives, CustomerErrorCode.TooLarge],
        [CustomerOperation.LeaveHive, CustomerErrorCode.NotFound],
    ])
    public readonly Host = new ContractHost()
    public RetryAfter: string | undefined = String(RefusingEdge.RetryAfterSeconds)

    public async Start(): Promise<this>
    {
        for (const [operation, code] of RefusingEdge.Refusals)
        {
            this.Host.Routes.Add({
                Method: HttpMethod.Post,
                Pattern: CustomerApiLink.PublicPathOf(operation),
                Auth: RouteAuth.Public,
                Handler: async (context: RequestContext) =>
                {
                    await context.ReadJson()
                    if (code === CustomerErrorCode.RateLimited && this.RetryAfter !== undefined)
                    {
                        context.Response.setHeader(RefusingEdge.RetryAfterHeader, this.RetryAfter)
                    }
                    throw new CustomerApiError(code)
                },
            })
        }
        await this.Host.Start()
        return this
    }
}

describe('the edge\'s own refusals reach the cabinet by code', () =>
{
    const edge = new RefusingEdge()
    let cabinet: CustomerApiClient

    before(async () =>
    {
        await edge.Start()
        cabinet = new CustomerApiClient(edge.Host.BaseUrl)
    })

    after(async () =>
    {
        await edge.Host.Stop()
    })

    it('gives each edge refusal its status', () =>
    {
        assert.deepEqual([CustomerErrorCode.NotFound, CustomerErrorCode.TooLarge, CustomerErrorCode.RateLimited].map(code => CustomerErrorCodes.StatusOf(code)), [404, 413, 429])
    })

    it('answers rate-limited with the seconds of Retry-After', async () =>
    {
        edge.RetryAfter = String(RefusingEdge.RetryAfterSeconds)
        await assert.rejects(cabinet.ListTenants(RefusingEdge.Token, new ListTenantsRequest('acme')), (err: unknown) =>
            err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.RateLimited && err.RetryAfterSeconds === RefusingEdge.RetryAfterSeconds)
    })

    it('leaves the seconds undefined without a Retry-After in seconds', async () =>
    {
        edge.RetryAfter = 'Wed, 21 Oct 2026 07:28:00 GMT'
        await assert.rejects(cabinet.ListTenants(RefusingEdge.Token, new ListTenantsRequest('acme')), (err: unknown) =>
            err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.RateLimited && err.RetryAfterSeconds === undefined)
    })

    it('answers too-large and not-found by their codes, not as unavailable', async () =>
    {
        await assert.rejects(cabinet.ListHives(RefusingEdge.Token, new ListHivesRequest('acme')), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.TooLarge)
        await assert.rejects(cabinet.LeaveHive(RefusingEdge.Token, new LeaveHiveRequest('acme', 'hive-1')), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.NotFound)
    })
})
