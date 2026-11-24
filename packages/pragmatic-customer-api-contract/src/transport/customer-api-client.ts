import { JsonFields, JsonPostClient, JsonPostUnavailableError } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerApiLink, CustomerOperation } from '../customer-api-link.js'
import { CustomerApiError, CustomerErrorCode, CustomerErrorCodes } from '../errors/customer-api-error.js'
import { TenantList, TenantView } from '../dto/tenant.js'
import type { CreateTenantRequest, ListTenantsRequest } from '../dto/tenant.js'
import { EnrolmentStart, EnvironmentRequest, HiveList, HiveView } from '../dto/hive.js'
import type { ListHivesRequest, LeaveHiveRequest, RequestEnvironmentRequest, StartEnrolmentRequest } from '../dto/hive.js'
import { DomainVerification } from '../dto/domain.js'
import type { DomainVerificationRequest } from '../dto/domain.js'

/**
 * The personal cabinet's client for the customer API through the platform edge: each call carries the customer's
 * central-login token as its bearer. Every refusal is a CustomerApiError with the platform's code (and reason); no
 * answer, or one that is not the contract's, is `unavailable`.
 */
export class CustomerApiClient
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly CodeField = 'code'
    private static readonly RetryAfterHeader = 'retry-after'
    private static readonly SecondsPattern = /^\d{1,9}$/

    private readonly client: JsonPostClient

    public constructor(edgeBaseUrl: string, timeoutMs: number = JsonPostClient.DefaultTimeoutMs)
    {
        this.client = new JsonPostClient(edgeBaseUrl, timeoutMs)
    }

    public CreateTenant(customerToken: string, request: CreateTenantRequest): Promise<TenantView>
    {
        return this.Call(CustomerOperation.CreateTenant, customerToken, request.ToJson(), body => TenantView.Parse(body))
    }

    public async ListTenants(customerToken: string, request: ListTenantsRequest): Promise<readonly TenantView[]>
    {
        return (await this.Call(CustomerOperation.ListTenants, customerToken, request.ToJson(), body => TenantList.Parse(body))).Tenants
    }

    public StartEnrolment(customerToken: string, request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        return this.Call(CustomerOperation.StartEnrolment, customerToken, request.ToJson(), body => EnrolmentStart.Parse(body))
    }

    public async ListHives(customerToken: string, request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        return (await this.Call(CustomerOperation.ListHives, customerToken, request.ToJson(), body => HiveList.Parse(body))).Hives
    }

    public StartDomainVerification(customerToken: string, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return this.Call(CustomerOperation.StartDomainVerification, customerToken, request.ToJson(), body => DomainVerification.Parse(body))
    }

    public CheckDomainVerification(customerToken: string, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return this.Call(CustomerOperation.CheckDomainVerification, customerToken, request.ToJson(), body => DomainVerification.Parse(body))
    }

    public LeaveHive(customerToken: string, request: LeaveHiveRequest): Promise<HiveView>
    {
        return this.Call(CustomerOperation.LeaveHive, customerToken, request.ToJson(), body => HiveView.Parse(body))
    }

    public RequestEnvironment(customerToken: string, request: RequestEnvironmentRequest): Promise<EnvironmentRequest>
    {
        return this.Call(CustomerOperation.RequestEnvironment, customerToken, request.ToJson(), body => EnvironmentRequest.Parse(body))
    }

    private async Call<T>(operation: CustomerOperation, customerToken: string, body: unknown, parse: (body: unknown) => T): Promise<T>
    {
        let reply
        try
        {
            reply = await this.client.Post(CustomerApiLink.PublicPathOf(operation), body, { [CustomerApiClient.AuthorizationHeader]: CustomerApiClient.BearerPrefix + customerToken })
        }
        catch (err)
        {
            throw err instanceof JsonPostUnavailableError ? new CustomerApiError(CustomerErrorCode.Unavailable) : err
        }
        if (!reply.Ok)
        {
            const answer = JsonFields.IsObject(reply.Body) ? reply.Body : {}
            const code = CustomerErrorCodes.Parse(answer[CustomerApiClient.CodeField]) ?? CustomerErrorCode.Unavailable
            const reason = code === CustomerErrorCode.NotEntitled ? CustomerErrorCodes.ParseReason(answer[CustomerApiError.ReasonField]) : undefined
            const retryAfter = code === CustomerErrorCode.RateLimited ? CustomerApiClient.RetryAfterOf(reply.Headers[CustomerApiClient.RetryAfterHeader]) : undefined
            throw new CustomerApiError(code, reason, retryAfter)
        }
        try
        {
            return parse(reply.Body)
        }
        catch
        {
            throw new CustomerApiError(CustomerErrorCode.Unavailable)
        }
    }

    /** The whole seconds of a `Retry-After` header, or undefined for none or an HTTP date. */
    private static RetryAfterOf(header: string | string[] | undefined): number | undefined
    {
        return typeof header === 'string' && CustomerApiClient.SecondsPattern.test(header.trim()) ? Number(header.trim()) : undefined
    }
}
