import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HttpMethod, RouteAuth } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CentralLoginSubject, ClientKind, CustomerCallAuthenticator, EntitledOperation, EntitlementLimits, EntitlementState, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ICentralLoginVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiLink } from '../customer-api-link.js'
import { CustomerApiRoutes } from '../transport/customer-api-routes.js'
import { CustomerApiClient } from '../transport/customer-api-client.js'
import { CustomerApiRelay } from '../transport/customer-api-relay.js'
import type { ICustomerApiService } from '../transport/customer-api-service.js'
import { CustomerApiGate } from '../gate/customer-api-gate.js'
import { CustomerApiError, CustomerErrorCode, NotEntitledReason } from '../errors/customer-api-error.js'
import { CreateTenantRequest, ListTenantsRequest, TenantView } from '../dto/tenant.js'
import {
    EnrolmentStart, EnvironmentReport, EnvironmentRequest, HiveHealth, HiveLevel, HiveLevels, HiveView, LeaveHiveRequest, ListHivesRequest, RequestedEnvironmentPurpose,
    RequestEnvironmentRequest, StartEnrolmentRequest,
} from '../dto/hive.js'
import { DomainVerification, DomainVerificationRequest, DomainVerificationState } from '../dto/domain.js'
import { ContractHost } from './support/contract-host.js'

class People
{
    public static readonly Issuer = 'https://securetoken.google.com/pragmatic-identity'
    public static readonly Alice = CentralLoginSubject.Of(People.Issuer, 'alice', 'alice@acme.com')
    public static readonly Mallory = CentralLoginSubject.Of(People.Issuer, 'mallory', 'm@evil.example')
    public static readonly Tokens: ReadonlyMap<string, CentralLoginSubject> = new Map([['alice-token', People.Alice], ['mallory-token', People.Mallory]])
}

class Verifier implements ICentralLoginVerifier
{
    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        return People.Tokens.get(token)
    }
}

/** The platform admin console's side in memory: statements per client, tenants and hives; every method gated. */
class MemoryPlatform implements ICustomerApiService
{
    public readonly Statements = new Map<string, EntitlementStatement>()
    public readonly Tenants: TenantView[] = []
    public readonly Hives: HiveView[] = [new HiveView('hive-1', 'acme-main', HiveLevel.Enrolled, true, HiveHealth.Healthy, new Date('2026-11-20T09:00:00.000Z'), [new EnvironmentReport('prod', true, '1.2.3')])]

    public State(state: EntitlementState, limits: Record<string, number> = { tenants: 1, hives: 1, 'verified-domains': 2 }): void
    {
        this.Statements.set('acme', EntitlementStatement.Create({ ClientId: 'acme', ClientKind: ClientKind.Organisation, ClientName: 'Acme', Admins: [People.Alice], PlanId: 'team', Limits: EntitlementLimits.Of(limits), State: state, Version: 1, IssuedAt: new Date() }))
    }

    public async CreateTenant(customer: CentralLoginSubject, request: CreateTenantRequest): Promise<TenantView>
    {
        CustomerApiGate.RequireEntitled(request.ClientId, this.Statements.get(request.ClientId), customer, EntitledOperation.CreateTenant, this.Tenants.length)
        const tenant = new TenantView(request.TenantId, request.ClientId, request.DisplayName, new Date('2026-11-20T10:00:00.000Z'))
        this.Tenants.push(tenant)
        return tenant
    }

    public async ListTenants(customer: CentralLoginSubject, request: ListTenantsRequest): Promise<readonly TenantView[]>
    {
        CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
        return this.Tenants
    }

    public async StartEnrolment(customer: CentralLoginSubject, request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        if (!HiveLevels.Enrols(request.Level))
        {
            CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
            return EnrolmentStart.Standalone('helm install pragmatic oci://ghcr.io/pragmatic-tech-ai/charts/engine')
        }
        CustomerApiGate.RequireEntitled(request.ClientId, this.Statements.get(request.ClientId), customer, EntitledOperation.EnrolHive, this.Hives.length)
        return request.Level === HiveLevel.Hosted
            ? EnrolmentStart.Hosted('placement-1')
            : EnrolmentStart.Connected(request.Level as HiveLevel.Enrolled, 'helm install pragmatic oci://ghcr.io/pragmatic-tech-ai/charts/engine', 'ENROL-abcdefghijklmnop', new Date('2026-11-20T11:00:00.000Z'))
    }

    public async ListHives(customer: CentralLoginSubject, request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
        return this.Hives.filter(hive => request.TenantId === null || hive.TenantId === request.TenantId)
    }

    public async StartDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        CustomerApiGate.RequireEntitled(request.ClientId, this.Statements.get(request.ClientId), customer, EntitledOperation.VerifyEmailDomain, 0)
        return new DomainVerification(request.TenantId, request.Domain, DomainVerificationState.Pending, '_pragmatic.' + request.Domain, 'pragmatic-verification=abc')
    }

    public async CheckDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
        return new DomainVerification(request.TenantId, request.Domain, DomainVerificationState.Verified, '_pragmatic.' + request.Domain, 'pragmatic-verification=abc')
    }

    public async LeaveHive(customer: CentralLoginSubject, request: LeaveHiveRequest): Promise<HiveView>
    {
        CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
        const hive = this.Hives.find(candidate => candidate.HiveId === request.HiveId)
        if (hive === undefined)
        {
            throw new CustomerApiError(CustomerErrorCode.UnknownHive)
        }
        return new HiveView(hive.HiveId, hive.TenantId, hive.Level, hive.Home, HiveHealth.Gone, hive.LastReportAt, [])
    }

    public async RequestEnvironment(customer: CentralLoginSubject, request: RequestEnvironmentRequest): Promise<EnvironmentRequest>
    {
        CustomerApiGate.RequireAdmin(request.ClientId, this.Statements.get(request.ClientId), customer)
        const hive = this.Hives.find(candidate => candidate.HiveId === request.HiveId)
        if (hive === undefined)
        {
            throw new CustomerApiError(CustomerErrorCode.UnknownHive)
        }
        if (hive.Level !== HiveLevel.Enrolled && hive.Level !== HiveLevel.Delegated)
        {
            throw new CustomerApiError(CustomerErrorCode.HiveTakesNoIntents)
        }
        return new EnvironmentRequest('inabcdefghijkl', hive.HiveId, hive.Level, new Date('2026-12-01T00:00:00.000Z'))
    }
}

class Refused
{
    public static async With(call: Promise<unknown>, code: CustomerErrorCode, reason?: NotEntitledReason): Promise<void>
    {
        await assert.rejects(call, (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === code && err.Reason === reason)
    }
}

describe('customer API: cabinet -> edge -> platform admin console', () =>
{
    const credential = CustomerApiLink.CredentialFromSecret(Buffer.alloc(32, 2))
    let admin: ContractHost
    let edge: ContractHost
    let platform: MemoryPlatform
    let cabinet: CustomerApiClient

    beforeEach(async () =>
    {
        platform = new MemoryPlatform()
        platform.State(EntitlementState.Active)
        admin = new ContractHost()
        new CustomerApiRoutes(platform, new CustomerCallAuthenticator(credential, new Verifier())).MountOn(admin.Routes)
        await admin.Start()
        edge = new ContractHost()
        const relay = new CustomerApiRelay(admin.BaseUrl, credential)
        for (const operation of CustomerApiLink.Operations)
        {
            edge.Routes.Add({ Method: HttpMethod.Post, Pattern: CustomerApiLink.PublicPathOf(operation), Auth: RouteAuth.Public, Handler: async context =>
            {
                const found = relay.OperationOf(context.Request.method, context.Path)
                const header = context.Request.headers.authorization
                const reply = await relay.Relay(found as typeof operation, typeof header === 'string' ? header : undefined, await context.ReadJson())
                context.WriteJson(reply.Status, reply.Body)
            } })
        }
        await edge.Start()
        cabinet = new CustomerApiClient(edge.BaseUrl)
    })

    afterEach(async () =>
    {
        await edge.Stop()
        await admin.Stop()
    })

    it('creates a tenant for an admin of an entitled client, then lists it', async () =>
    {
        const tenant = await cabinet.CreateTenant('alice-token', new CreateTenantRequest('acme', 'acme-main', 'Acme main'))
        assert.equal(tenant.TenantId, 'acme-main')
        assert.deepEqual((await cabinet.ListTenants('alice-token', new ListTenantsRequest('acme'))).map(t => t.TenantId), ['acme-main'])
    })

    it('refuses past the limit, outside the plan and while suspended, with the reason', async () =>
    {
        await cabinet.CreateTenant('alice-token', new CreateTenantRequest('acme', 'acme-main', 'Acme main'))
        await Refused.With(cabinet.CreateTenant('alice-token', new CreateTenantRequest('acme', 'acme-two', 'Two')), CustomerErrorCode.NotEntitled, NotEntitledReason.LimitReached)
        platform.State(EntitlementState.Active, { tenants: 5 })
        await Refused.With(cabinet.StartEnrolment('alice-token', new StartEnrolmentRequest('acme', 'acme-main', HiveLevel.Enrolled)), CustomerErrorCode.NotEntitled, NotEntitledReason.NotInPlan)
        platform.State(EntitlementState.Suspended)
        await Refused.With(cabinet.CreateTenant('alice-token', new CreateTenantRequest('acme', 'acme-two', 'Two')), CustomerErrorCode.NotEntitled, NotEntitledReason.Suspended)
        assert.equal((await cabinet.ListHives('alice-token', new ListHivesRequest('acme'))).length, 1, 'reads stay open while suspended')
    })

    it('refuses a signed-in stranger and an unknown client the same way', async () =>
    {
        await Refused.With(cabinet.ListTenants('mallory-token', new ListTenantsRequest('acme')), CustomerErrorCode.NotAdminOfClient)
        await Refused.With(cabinet.ListTenants('alice-token', new ListTenantsRequest('globex')), CustomerErrorCode.NotAdminOfClient)
    })

    it('refuses a forged or missing customer token at the console, and a missing bearer at the edge', async () =>
    {
        await Refused.With(cabinet.ListTenants('forged', new ListTenantsRequest('acme')), CustomerErrorCode.NotSignedIn)
        const raw = await fetch(edge.BaseUrl + CustomerApiLink.PublicPathOf(CustomerApiLink.Operations[1]), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ClientId":"acme"}' })
        assert.equal(raw.status, 401)
        assert.equal(((await raw.json()) as { code: string }).code, 'not-signed-in')
    })

    it('refuses a caller of the internal face without the edge bearer', async () =>
    {
        const direct = await fetch(admin.BaseUrl + CustomerApiLink.InternalPathOf(CustomerApiLink.Operations[1]), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pragmatic-customer-token': 'alice-token' },
            body: '{"ClientId":"acme"}',
        })
        assert.equal(direct.status, 401)
        assert.equal(((await direct.json()) as { code: string }).code, 'unauthorized')
    })

    it('starts an enrolment per level', async () =>
    {
        const standalone = await cabinet.StartEnrolment('alice-token', new StartEnrolmentRequest('acme', 'acme-main', HiveLevel.Standalone))
        assert.deepEqual([standalone.Level, standalone.EnrolmentCode, standalone.PlacementId], [HiveLevel.Standalone, null, null])
        assert.ok(standalone.InstallCommand?.startsWith('helm install'))
        const enrolled = await cabinet.StartEnrolment('mallory-token', new StartEnrolmentRequest('acme', 'acme-main', HiveLevel.Standalone)).catch((err: unknown) => err)
        assert.ok(enrolled instanceof CustomerApiError)
        platform.State(EntitlementState.Active, { hives: 5 })
        const connected = await cabinet.StartEnrolment('alice-token', new StartEnrolmentRequest('acme', 'acme-main', HiveLevel.Enrolled))
        assert.equal(connected.EnrolmentCode, 'ENROL-abcdefghijklmnop')
        assert.equal(connected.ExpiresAt?.toISOString(), '2026-11-20T11:00:00.000Z')
        const hosted = await cabinet.StartEnrolment('alice-token', new StartEnrolmentRequest('acme', 'acme-main', HiveLevel.Hosted))
        assert.deepEqual([hosted.InstallCommand, hosted.PlacementId], [null, 'placement-1'])
    })

    it('lists hives with health and environment reports, and leaves one', async () =>
    {
        const [hive] = await cabinet.ListHives('alice-token', new ListHivesRequest('acme', 'acme-main'))
        assert.deepEqual(hive?.Environments.map(environment => environment.ToJson()), [{ Name: 'prod', Ready: true, Version: '1.2.3' }])
        const requested = await cabinet.RequestEnvironment('alice-token', new RequestEnvironmentRequest('acme', 'hive-1', 'prod', RequestedEnvironmentPurpose.Runtime))
        assert.equal(requested.IntentId, 'inabcdefghijkl')
        await Refused.With(cabinet.RequestEnvironment('alice-token', new RequestEnvironmentRequest('acme', 'hive-9', 'prod', RequestedEnvironmentPurpose.Runtime)), CustomerErrorCode.UnknownHive)
        platform.Hives.push(new HiveView('hive-2', 'acme-main', HiveLevel.Hosted, false, HiveHealth.Healthy, null, []))
        await Refused.With(cabinet.RequestEnvironment('alice-token', new RequestEnvironmentRequest('acme', 'hive-2', 'prod', RequestedEnvironmentPurpose.Development)), CustomerErrorCode.HiveTakesNoIntents)
        const left = await cabinet.LeaveHive('alice-token', new LeaveHiveRequest('acme', 'hive-1'))
        assert.equal(left.Health, HiveHealth.Gone)
        await Refused.With(cabinet.LeaveHive('alice-token', new LeaveHiveRequest('acme', 'hive-9')), CustomerErrorCode.UnknownHive)
    })

    it('starts and checks a domain verification; refuses a domain that is not one', async () =>
    {
        const started = await cabinet.StartDomainVerification('alice-token', new DomainVerificationRequest('acme', 'acme-main', 'acme.com'))
        assert.deepEqual([started.State, started.RecordType, started.RecordName], [DomainVerificationState.Pending, 'TXT', '_pragmatic.acme.com'])
        assert.equal((await cabinet.CheckDomainVerification('alice-token', new DomainVerificationRequest('acme', 'acme-main', 'acme.com'))).State, DomainVerificationState.Verified)
        await Refused.With(cabinet.StartDomainVerification('alice-token', new DomainVerificationRequest('acme', 'acme-main', 'localhost')), CustomerErrorCode.InvalidDomain)
    })

    it('reports a console that does not answer as unavailable, through the edge', async () =>
    {
        await admin.Stop()
        await Refused.With(cabinet.ListTenants('alice-token', new ListTenantsRequest('acme')), CustomerErrorCode.Unavailable)
    })
})
