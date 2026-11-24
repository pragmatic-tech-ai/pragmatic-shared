import type { CentralLoginSubject } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CreateTenantRequest, ListTenantsRequest, TenantView } from '../dto/tenant.js'
import type { StartEnrolmentRequest, EnrolmentStart, ListHivesRequest, HiveView, LeaveHiveRequest, RequestEnvironmentRequest, EnvironmentRequest } from '../dto/hive.js'
import type { DomainVerificationRequest, DomainVerification } from '../dto/domain.js'

/**
 * What the platform admin console implements behind the customer API. `customer` is the caller's verified
 * central-login subject. Each method first checks it against the client's latest entitlement statement
 * (CustomerApiGate: admin of the client; entitled for a gated operation) and throws a CustomerApiError to refuse.
 */
export interface ICustomerApiService
{
    CreateTenant(customer: CentralLoginSubject, request: CreateTenantRequest): Promise<TenantView>
    ListTenants(customer: CentralLoginSubject, request: ListTenantsRequest): Promise<readonly TenantView[]>
    StartEnrolment(customer: CentralLoginSubject, request: StartEnrolmentRequest): Promise<EnrolmentStart>
    ListHives(customer: CentralLoginSubject, request: ListHivesRequest): Promise<readonly HiveView[]>
    StartDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    CheckDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    LeaveHive(customer: CentralLoginSubject, request: LeaveHiveRequest): Promise<HiveView>
    /** An environment on an Enrolled or Delegated hive, recorded as a create-environment intent (C3.4). */
    RequestEnvironment(customer: CentralLoginSubject, request: RequestEnvironmentRequest): Promise<EnvironmentRequest>
}
