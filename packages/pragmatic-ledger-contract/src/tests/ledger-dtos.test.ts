import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BadRequestProblem } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ClientView, MyClientReply, RegisterClientRequest } from '../dto/client.js'
import { PlanList } from '../dto/plan.js'
import { CheckoutReference, StartCheckoutRequest } from '../dto/checkout.js'
import { CancelSubscriptionRequest, SubscriptionView } from '../dto/subscription.js'

class Dto
{
    public static RoundTrips(parse: (value: unknown) => { ToJson(): unknown }, json: unknown): void
    {
        assert.deepEqual(parse(JSON.parse(JSON.stringify(json))).ToJson(), json)
    }

    public static Refuses(parse: (value: unknown) => unknown, json: unknown): void
    {
        assert.throws(() => parse(json), BadRequestProblem)
    }
}

describe('ledger DTOs', () =>
{
    const admin = { Issuer: 'https://securetoken.google.com/p', Subject: 's', Email: 'a@b.c' }
    const subscription = { PlanId: 'team', State: 'past-due', PaddleSubscriptionId: 'sub_01habcdefghij', CurrentPeriodEnd: '2026-12-01T00:00:00.000Z', CancelsAt: null }

    it('round-trips every DTO', () =>
    {
        Dto.RoundTrips(value => RegisterClientRequest.Parse(value), { Kind: 'organisation', Name: 'Acme', Code: null })
        Dto.RoundTrips(value => ClientView.Parse(value), { ClientId: 'acme', Kind: 'person', Name: 'A', Admins: [admin], Subscription: subscription })
        Dto.RoundTrips(value => MyClientReply.Parse(value), { Client: null })
        Dto.RoundTrips(value => SubscriptionView.Parse(value), { ...subscription, PaddleSubscriptionId: null })
        Dto.RoundTrips(value => PlanList.Parse(value), { Plans: [{ PlanId: 'free', Name: 'Free', Description: '', Limits: { tenants: 1 }, PaddlePriceId: null }] })
        Dto.RoundTrips(value => StartCheckoutRequest.Parse(value), { PlanId: 'team' })
        Dto.RoundTrips(value => CheckoutReference.Parse(value), { Provider: 'paddle', TransactionId: 'txn_01habcdefghij', CheckoutUrl: null })
        Dto.RoundTrips(value => CancelSubscriptionRequest.Parse(value), { When: 'immediately' })
    })

    it('refuses money, unknown members and malformed references', () =>
    {
        Dto.Refuses(value => PlanList.Parse(value), { Plans: [{ PlanId: 'team', Name: 'T', Description: '', Limits: {}, PaddlePriceId: null, Amount: 10 }] })
        Dto.Refuses(value => RegisterClientRequest.Parse(value), { Kind: 'person', Name: 'A', Admin: admin })
        Dto.Refuses(value => RegisterClientRequest.Parse(value), { Kind: 'person', Name: 'A', Code: 'has space' })
        Dto.Refuses(value => CheckoutReference.Parse(value), { Provider: 'stripe', TransactionId: 'txn_01habcdefghij', CheckoutUrl: null })
        Dto.Refuses(value => CheckoutReference.Parse(value), { Provider: 'paddle', TransactionId: 'not-an-id', CheckoutUrl: null })
        Dto.Refuses(value => CheckoutReference.Parse(value), { Provider: 'paddle', TransactionId: 'txn_01habcdefghij', CheckoutUrl: 'javascript:alert(1)' })
        Dto.Refuses(value => SubscriptionView.Parse(value), { ...subscription, State: 'unknown' })
        Dto.Refuses(value => CancelSubscriptionRequest.Parse(value), { When: 'tomorrow' })
    })

    it('defaults a cancellation to the end of the period', () =>
    {
        assert.equal(CancelSubscriptionRequest.Parse({}).When, 'period-end')
    })
})
