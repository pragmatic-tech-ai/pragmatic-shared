import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Entitlement, EntitlementDecision, EntitlementLimits, EntitlementState } from '../entitlement/entitlement.js'
import { EntitledOperation, EntitledOperations, EntitlementLimit } from '../entitlement/entitled-operation.js'

describe('Entitlement', () =>
{
    const limits = EntitlementLimits.Of({ tenants: 1, hives: 3, 'verified-domains': 0 })

    it('maps each gated operation to the limit it consumes', () =>
    {
        assert.equal(EntitledOperations.LimitOf(EntitledOperation.CreateTenant), EntitlementLimit.Tenants)
        assert.equal(EntitledOperations.LimitOf(EntitledOperation.EnrolHive), EntitlementLimit.Hives)
        assert.equal(EntitledOperations.LimitOf(EntitledOperation.VerifyEmailDomain), EntitlementLimit.VerifiedDomains)
        assert.deepEqual(EntitledOperations.All, ['create-tenant', 'enrol-hive', 'verify-email-domain'])
    })

    it('allows below the limit and refuses at it', () =>
    {
        const entitlement = new Entitlement(EntitlementState.Active, limits)
        assert.equal(entitlement.Allows(EntitledOperation.CreateTenant, 0), true)
        assert.equal(entitlement.Decide(EntitledOperation.CreateTenant, 1), EntitlementDecision.LimitReached)
        assert.equal(entitlement.Decide(EntitledOperation.EnrolHive, 2), EntitlementDecision.Allowed)
        assert.equal(entitlement.Decide(EntitledOperation.EnrolHive, 3), EntitlementDecision.LimitReached)
        assert.equal(entitlement.Decide(EntitledOperation.VerifyEmailDomain, 0), EntitlementDecision.LimitReached)
    })

    it('refuses an operation whose limit the plan does not carry', () =>
    {
        const entitlement = new Entitlement(EntitlementState.Active, EntitlementLimits.Of({ tenants: 1 }))
        assert.equal(entitlement.Decide(EntitledOperation.EnrolHive, 0), EntitlementDecision.NotInPlan)
        assert.equal(entitlement.Allows(EntitledOperation.EnrolHive, 0), false)
    })

    it('refuses everything while suspended', () =>
    {
        const entitlement = new Entitlement(EntitlementState.Suspended, limits)
        for (const operation of EntitledOperations.All)
        {
            assert.equal(entitlement.Decide(operation, 0), EntitlementDecision.Suspended)
        }
    })

    it('refuses a usage that is not a count, and limits that are not counts', () =>
    {
        const entitlement = new Entitlement(EntitlementState.Active, limits)
        assert.throws(() => entitlement.Decide(EntitledOperation.CreateTenant, -1), RangeError)
        assert.throws(() => entitlement.Decide(EntitledOperation.CreateTenant, 0.5), RangeError)
        assert.throws(() => EntitlementLimits.Of({ tenants: -1 }), RangeError)
        assert.throws(() => EntitlementLimits.Of({ Tenants: 1 }), RangeError)
    })
})
