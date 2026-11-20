import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BadRequestProblem } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementDecision } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, TenantList } from '../dto/tenant.js'
import { EnrolmentStart, HiveLevel, HiveList, StartEnrolmentRequest } from '../dto/hive.js'
import { DomainVerification, DomainVerificationRequest, EmailDomain } from '../dto/domain.js'
import { CustomerApiError, CustomerErrorCode, CustomerErrorCodes, NotEntitledReason } from '../errors/customer-api-error.js'
import { CustomerApiLink, CustomerOperation } from '../customer-api-link.js'

class Dto
{
    public static RoundTrips(parse: (value: unknown) => { ToJson(): unknown }, json: unknown): void
    {
        assert.deepEqual(parse(JSON.parse(JSON.stringify(json))).ToJson(), json)
    }
}

describe('customer API DTOs', () =>
{
    it('round-trips the DTOs', () =>
    {
        Dto.RoundTrips(value => CreateTenantRequest.Parse(value), { ClientId: 'acme', TenantId: 'acme-main', DisplayName: 'Acme' })
        Dto.RoundTrips(value => TenantList.Parse(value), { Tenants: [{ TenantId: 'acme-main', ClientId: 'acme', DisplayName: 'Acme', CreatedAt: '2026-11-20T10:00:00.000Z' }] })
        Dto.RoundTrips(value => HiveList.Parse(value), { Hives: [{ HiveId: 'h1', TenantId: 'acme-main', Level: 'delegated', Home: false, Health: 'pending', LastReportAt: null, Environments: [] }] })
        Dto.RoundTrips(value => DomainVerification.Parse(value), { TenantId: 'acme-main', Domain: 'acme.com', State: 'failed', RecordType: 'TXT', RecordName: '_p.acme.com', RecordValue: 'v' })
        Dto.RoundTrips(value => EnrolmentStart.Parse(value), { Level: 'delegated', InstallCommand: 'helm install x', EnrolmentCode: 'abcdefghijklmnop', ExpiresAt: '2026-11-20T11:00:00.000Z', PlacementId: null })
    })

    it('holds an enrolment start to the shape of its level', () =>
    {
        assert.throws(() => EnrolmentStart.Parse({ Level: 'standalone', InstallCommand: 'helm install x', EnrolmentCode: 'abcdefghijklmnop', ExpiresAt: '2026-11-20T11:00:00.000Z', PlacementId: null }), BadRequestProblem)
        assert.throws(() => EnrolmentStart.Parse({ Level: 'enrolled', InstallCommand: 'helm install x', EnrolmentCode: null, ExpiresAt: null, PlacementId: null }), BadRequestProblem)
        assert.throws(() => EnrolmentStart.Parse({ Level: 'hosted', InstallCommand: 'helm install x', EnrolmentCode: null, ExpiresAt: null, PlacementId: 'p1' }), BadRequestProblem)
        assert.throws(() => EnrolmentStart.Hosted('Not An Id'), BadRequestProblem)
        assert.equal(EnrolmentStart.Hosted('p1').Level, HiveLevel.Hosted)
    })

    it('refuses bad ids, levels and domains', () =>
    {
        assert.throws(() => CreateTenantRequest.Parse({ ClientId: 'acme', TenantId: 'A', DisplayName: 'x' }), BadRequestProblem)
        assert.throws(() => StartEnrolmentRequest.Parse({ ClientId: 'acme', TenantId: 'acme-main', Level: 'root' }), BadRequestProblem)
        assert.throws(() => DomainVerificationRequest.Parse({ ClientId: 'acme', TenantId: 'acme-main', Domain: 'ACME.com' }), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.InvalidDomain)
        assert.equal(EmailDomain.IsValid('mail.acme.co.uk'), true)
        assert.equal(EmailDomain.IsValid('acme'), false)
    })

    it('maps every code to a status, each refusing decision to a reason, and writes the reason beside the code', () =>
    {
        for (const code of CustomerErrorCodes.All)
        {
            assert.ok(CustomerErrorCodes.StatusOf(code) >= 400)
        }
        assert.equal(CustomerErrorCodes.ReasonOf(EntitlementDecision.Allowed), undefined)
        assert.equal(CustomerErrorCodes.ReasonOf(EntitlementDecision.LimitReached), NotEntitledReason.LimitReached)
        assert.deepEqual(new CustomerApiError(CustomerErrorCode.NotEntitled, NotEntitledReason.Suspended).Fields(), { code: 'not-entitled', reason: 'suspended' })
    })

    it('names the two faces of every operation', () =>
    {
        assert.equal(CustomerApiLink.PublicPathOf(CustomerOperation.CreateTenant), '/api/customer/v1/create-tenant')
        assert.equal(CustomerApiLink.InternalPathOf(CustomerOperation.CreateTenant), '/internal/customer/v1/create-tenant')
        assert.equal(CustomerApiLink.OperationOfPublicPath('/api/customer/v1/leave-hive'), CustomerOperation.LeaveHive)
        assert.equal(CustomerApiLink.OperationOfPublicPath('/internal/customer/v1/leave-hive'), undefined)
    })
})
