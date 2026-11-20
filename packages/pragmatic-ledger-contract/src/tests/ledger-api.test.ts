import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CentralLoginSubject, ClientKind, CustomerCallAuthenticator, EntitlementLimits } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ICentralLoginVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { LedgerApiLink, LedgerOperation } from '../ledger-api-link.js'
import { LedgerApiRoutes } from '../transport/ledger-api-routes.js'
import { LedgerApiClient } from '../transport/ledger-api-client.js'
import type { ILedgerApiService } from '../transport/ledger-api-service.js'
import { LedgerApiError, LedgerErrorCode, LedgerErrorCodes } from '../errors/ledger-api-error.js'
import { ClientView, RegisterClientRequest } from '../dto/client.js'
import { PlanView } from '../dto/plan.js'
import { CheckoutReference, StartCheckoutRequest } from '../dto/checkout.js'
import { CancelSubscriptionRequest, CancelWhen, SubscriptionState, SubscriptionView } from '../dto/subscription.js'
import { ContractHost } from './support/contract-host.js'

class Fixture
{
    public static readonly Issuer = 'https://securetoken.google.com/pragmatic-identity'
    public static readonly Alice = CentralLoginSubject.Of(Fixture.Issuer, 'alice', 'alice@acme.com')
    public static readonly Token = 'alice-token'
}

class Verifier implements ICentralLoginVerifier
{
    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        return token === Fixture.Token ? Fixture.Alice : undefined
    }
}

/** A ledger in memory: one client per admin. */
class MemoryLedger implements ILedgerApiService
{
    public readonly Calls: string[] = []
    private readonly clients = new Map<string, ClientView>()
    private readonly plans = [
        new PlanView('team', 'Team', 'For a team', EntitlementLimits.Of({ tenants: 1, hives: 3 }), 'pri_01hteam0000000'),
        new PlanView('internal', 'Internal', '', EntitlementLimits.Of({ tenants: 10 }), null),
    ]

    public async RegisterClient(customer: CentralLoginSubject, request: RegisterClientRequest): Promise<ClientView>
    {
        this.Calls.push('register ' + customer.Subject + ' ' + request.Kind + ' ' + String(request.Code))
        if (this.clients.has(customer.Key))
        {
            throw new LedgerApiError(LedgerErrorCode.AlreadyRegistered)
        }
        if (request.Code === 'bogus')
        {
            throw new LedgerApiError(LedgerErrorCode.InvalidCode)
        }
        const client = new ClientView('acme', request.Kind, request.Name, [customer], null)
        this.clients.set(customer.Key, client)
        return client
    }

    public async MyClient(customer: CentralLoginSubject): Promise<ClientView | null>
    {
        return this.clients.get(customer.Key) ?? null
    }

    public async ListPlans(): Promise<readonly PlanView[]>
    {
        return this.plans
    }

    public async StartCheckout(customer: CentralLoginSubject, request: StartCheckoutRequest): Promise<CheckoutReference>
    {
        const plan = this.plans.find(candidate => candidate.PlanId === request.PlanId)
        if (plan === undefined)
        {
            throw new LedgerApiError(LedgerErrorCode.UnknownPlan)
        }
        if (!plan.Purchasable)
        {
            throw new LedgerApiError(LedgerErrorCode.PlanNotPurchasable)
        }
        return new CheckoutReference('txn_01hcheckout000', 'https://pay.example/checkout?_ptxn=txn_01hcheckout000')
    }

    public async CancelSubscription(customer: CentralLoginSubject, request: CancelSubscriptionRequest): Promise<SubscriptionView>
    {
        this.Calls.push('cancel ' + request.When)
        return new SubscriptionView('team', SubscriptionState.Active, 'sub_01hsubscription', new Date('2026-12-20T00:00:00.000Z'), new Date('2026-12-20T00:00:00.000Z'))
    }
}

describe('ledger API', () =>
{
    const credential = LedgerApiLink.CredentialFromSecret(Buffer.alloc(32, 4))
    let host: ContractHost
    let ledger: MemoryLedger
    let client: LedgerApiClient

    beforeEach(async () =>
    {
        host = new ContractHost()
        ledger = new MemoryLedger()
        new LedgerApiRoutes(ledger, new CustomerCallAuthenticator(credential, new Verifier())).MountOn(host.Routes)
        await host.Start()
        client = new LedgerApiClient(host.BaseUrl, credential)
    })

    afterEach(async () => await host.Stop())

    it('declares one POST route per operation under the internal base path', () =>
    {
        const definitions = new LedgerApiRoutes(ledger, new CustomerCallAuthenticator(credential, new Verifier())).Definitions()
        assert.deepEqual(definitions.map(definition => definition.Pattern), LedgerApiLink.Operations.map(operation => '/internal/ledger/v1/' + operation))
        assert.ok(definitions.every(definition => definition.Method === 'POST'))
    })

    it('registers a client with the verified caller as its first admin, then reads it back', async () =>
    {
        assert.equal(await client.MyClient(Fixture.Token), null)
        const created = await client.RegisterClient(Fixture.Token, new RegisterClientRequest(ClientKind.Person, 'Alice', 'spring-2027'))
        assert.equal(created.Kind, ClientKind.Person)
        assert.deepEqual(created.Admins.map(admin => admin.Subject), ['alice'])
        assert.deepEqual(ledger.Calls, ['register alice person spring-2027'])
        assert.deepEqual((await client.MyClient(Fixture.Token))?.ToJson(), created.ToJson())
        await assert.rejects(client.RegisterClient(Fixture.Token, new RegisterClientRequest(ClientKind.Person, 'Alice')), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.AlreadyRegistered && err.Status === 409)
    })

    it('lists plans without a customer, with limits and Paddle price ids but no amounts', async () =>
    {
        const plans = await client.ListPlans()
        assert.deepEqual(plans.map(plan => [plan.PlanId, plan.Purchasable, plan.Limits.Get('hives') ?? null]), [['team', true, 3], ['internal', false, null]])
    })

    it('starts a checkout and answers Paddle references', async () =>
    {
        const checkout = await client.StartCheckout(Fixture.Token, new StartCheckoutRequest('team'))
        assert.deepEqual(checkout.ToJson(), { Provider: 'paddle', TransactionId: 'txn_01hcheckout000', CheckoutUrl: 'https://pay.example/checkout?_ptxn=txn_01hcheckout000' })
        await assert.rejects(client.StartCheckout(Fixture.Token, new StartCheckoutRequest('internal')), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.PlanNotPurchasable && err.Status === 422)
        await assert.rejects(client.StartCheckout(Fixture.Token, new StartCheckoutRequest('gold')), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.UnknownPlan)
    })

    it('cancels at period end by default', async () =>
    {
        const subscription = await client.CancelSubscription(Fixture.Token)
        assert.equal(subscription.CancelsAt?.toISOString(), '2026-12-20T00:00:00.000Z')
        await client.CancelSubscription(Fixture.Token, new CancelSubscriptionRequest(CancelWhen.Immediately))
        assert.deepEqual(ledger.Calls, ['cancel period-end', 'cancel immediately'])
    })

    it('answers a code the client turns back into the same error', async () =>
    {
        await assert.rejects(client.RegisterClient(Fixture.Token, new RegisterClientRequest(ClientKind.Organisation, 'Acme', 'bogus')), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.InvalidCode && err.Status === 400)
    })

    it('refuses a caller without the link bearer, and a customer whose token does not verify', async () =>
    {
        const stranger = new LedgerApiClient(host.BaseUrl, LedgerApiLink.CredentialFromSecret(Buffer.alloc(32, 8)))
        await assert.rejects(stranger.ListPlans(), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.Unauthorized)
        await assert.rejects(client.MyClient('forged'), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.NotSignedIn && err.Status === 401)
        assert.deepEqual(ledger.Calls, [])
    })

    it('refuses a malformed request with invalid-request, before the service', async () =>
    {
        const raw = await fetch(host.BaseUrl + LedgerApiLink.PathOf(LedgerOperation.RegisterClient), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...CustomerCallAuthenticator.Headers(credential, Fixture.Token) },
            body: JSON.stringify({ Kind: 'robot', Name: 'X', FirstAdmin: 'mallory' }),
        })
        assert.equal(raw.status, 400)
        assert.equal(((await raw.json()) as { code: string }).code, 'invalid-request')
        assert.deepEqual(ledger.Calls, [])
    })

    it('reports an unreachable ledger as unavailable', async () =>
    {
        const offline = new LedgerApiClient('http://127.0.0.1:1', credential, 500)
        await assert.rejects(offline.ListPlans(), (err: unknown) => err instanceof LedgerApiError && err.LedgerCode === LedgerErrorCode.Unavailable)
    })

    it('gives every code a status and a fixed message', () =>
    {
        for (const code of LedgerErrorCodes.All)
        {
            assert.ok(LedgerErrorCodes.StatusOf(code) >= 400)
            assert.ok(LedgerErrorCodes.MessageOf(code).length > 0)
        }
    })
})
