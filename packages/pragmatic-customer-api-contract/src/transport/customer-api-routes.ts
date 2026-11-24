import { HttpMethod, RouteAuth } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { RequestContext, RouteDefinition, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallOutcome } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiLink, CustomerOperation } from '../customer-api-link.js'
import { CustomerApiError, CustomerErrorCode } from '../errors/customer-api-error.js'
import { CreateTenantRequest, ListTenantsRequest, TenantList } from '../dto/tenant.js'
import { HiveList, LeaveHiveRequest, ListHivesRequest, RequestEnvironmentRequest, StartEnrolmentRequest } from '../dto/hive.js'
import { DomainVerificationRequest } from '../dto/domain.js'
import type { ICustomerApiService } from './customer-api-service.js'

/**
 * The platform admin console's internal face of the customer API as AppHost routes: every operation a `POST` under
 * the internal base path (RouteAuth.Public to the host: the caller is the platform edge, authenticated by the link
 * bearer, acting for the customer whose central-login token it forwards and the console verifies). Refusals answer
 * `{ error, code[, reason] }` with the code's status. Mount on the console's mesh/loopback listener, never a public one.
 */
export class CustomerApiRoutes
{
    private static readonly StatusOk = 200

    public constructor(private readonly service: ICustomerApiService, private readonly authenticator: CustomerCallAuthenticator)
    {
    }

    public Definitions(): RouteDefinition[]
    {
        return CustomerApiLink.Operations.map(operation => this.Definition(operation))
    }

    public MountOn(table: RouteTable): RouteTable
    {
        for (const definition of this.Definitions())
        {
            table.Add(definition)
        }
        return table
    }

    private Definition(operation: CustomerOperation): RouteDefinition
    {
        return {
            Method: HttpMethod.Post,
            Pattern: CustomerApiLink.InternalPathOf(operation),
            Auth: RouteAuth.Public,
            BodyLimit: CustomerApiLink.BodyLimit,
            Handler: async (context: RequestContext) =>
            {
                const call = await this.authenticator.Authenticate(context.Request.headers, true)
                if (call.Outcome === CustomerCallOutcome.Unauthorized)
                {
                    throw new CustomerApiError(CustomerErrorCode.Unauthorized)
                }
                if (call.Outcome === CustomerCallOutcome.NotSignedIn || call.Customer === undefined)
                {
                    throw new CustomerApiError(CustomerErrorCode.NotSignedIn)
                }
                const body = (await context.ReadJson()) ?? {}
                context.WriteJson(CustomerApiRoutes.StatusOk, await this.Handle(operation, call.Customer, body))
            },
        }
    }

    private async Handle(operation: CustomerOperation, customer: CentralLoginSubject, body: unknown): Promise<unknown>
    {
        const service = this.service
        switch (operation)
        {
            case CustomerOperation.CreateTenant:
                return (await service.CreateTenant(customer, CreateTenantRequest.Parse(body))).ToJson()
            case CustomerOperation.ListTenants:
                return new TenantList(await service.ListTenants(customer, ListTenantsRequest.Parse(body))).ToJson()
            case CustomerOperation.StartEnrolment:
                return (await service.StartEnrolment(customer, StartEnrolmentRequest.Parse(body))).ToJson()
            case CustomerOperation.ListHives:
                return new HiveList(await service.ListHives(customer, ListHivesRequest.Parse(body))).ToJson()
            case CustomerOperation.StartDomainVerification:
                return (await service.StartDomainVerification(customer, DomainVerificationRequest.Parse(body))).ToJson()
            case CustomerOperation.CheckDomainVerification:
                return (await service.CheckDomainVerification(customer, DomainVerificationRequest.Parse(body))).ToJson()
            case CustomerOperation.LeaveHive:
                return (await service.LeaveHive(customer, LeaveHiveRequest.Parse(body))).ToJson()
            case CustomerOperation.RequestEnvironment:
                return (await service.RequestEnvironment(customer, RequestEnvironmentRequest.Parse(body))).ToJson()
        }
    }
}
