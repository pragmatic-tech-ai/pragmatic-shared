import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The customer operations (each a `POST`, under the edge's public base path and the console's internal one). */
export enum CustomerOperation
{
    CreateTenant = 'create-tenant',
    ListTenants = 'list-tenants',
    StartEnrolment = 'start-enrolment',
    ListHives = 'list-hives',
    StartDomainVerification = 'start-domain-verification',
    CheckDomainVerification = 'check-domain-verification',
    LeaveHive = 'leave-hive',
    RequestEnvironment = 'request-environment',
}

/**
 * The two faces of the customer API: the platform edge's public one (the cabinet calls it with the customer's
 * central-login token as its bearer) and the platform admin console's internal one (the edge relays to it with the
 * link bearer, forwarding the customer's token). Paths, the link label, the body limit.
 */
export class CustomerApiLink
{
    public static readonly PublicBasePath = '/api/customer/v1/'
    public static readonly InternalBasePath = '/internal/customer/v1/'
    public static readonly CredentialLabel = 'pragmatic-customer-api/v1'
    public static readonly BodyLimit = 16384
    public static readonly Operations: readonly CustomerOperation[] = Object.values(CustomerOperation)

    public static PublicPathOf(operation: CustomerOperation): string
    {
        return CustomerApiLink.PublicBasePath + operation
    }

    public static InternalPathOf(operation: CustomerOperation): string
    {
        return CustomerApiLink.InternalBasePath + operation
    }

    /** The operation a public path names, or undefined. */
    public static OperationOfPublicPath(path: string): CustomerOperation | undefined
    {
        return CustomerApiLink.Operations.find(operation => CustomerApiLink.PublicPathOf(operation) === path)
    }

    public static CredentialFromFile(path: string): InternalApiCredential
    {
        return InternalApiCredential.FromFile(path, CustomerApiLink.CredentialLabel)
    }

    public static CredentialFromSecret(secret: Buffer): InternalApiCredential
    {
        return InternalApiCredential.FromSecret(secret, CustomerApiLink.CredentialLabel)
    }
}
