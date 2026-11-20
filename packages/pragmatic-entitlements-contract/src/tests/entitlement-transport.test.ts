import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HttpProblem, BadRequestProblem } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementReceiver } from '../transport/entitlement-receiver.js'
import { EntitlementSender, EntitlementDeliveryError } from '../transport/entitlement-sender.js'
import { EntitlementsLink } from '../transport/entitlements-link.js'
import { ReceiptOutcome } from '../transport/entitlement-receipt.js'
import type { IEntitlementSink } from '../transport/entitlement-sink.js'
import type { EntitlementStatement } from '../statement/entitlement-statement.js'
import { ContractHost } from './support/contract-host.js'
import { Samples } from './support/samples.js'

class MemorySink implements IEntitlementSink
{
    public readonly Applied: EntitlementStatement[] = []
    private readonly versions = new Map<string, number>()

    public async CurrentVersion(clientId: string): Promise<number | undefined>
    {
        await new Promise(resolve => setTimeout(resolve, 2))
        return this.versions.get(clientId)
    }

    public async Apply(statement: EntitlementStatement): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 2))
        this.versions.set(statement.ClientId, statement.Version)
        this.Applied.push(statement)
    }
}

describe('entitlement transport', () =>
{
    const credential = EntitlementsLink.CredentialFromSecret(Buffer.alloc(32, 5))
    let sink: MemorySink
    let host: ContractHost

    beforeEach(async () =>
    {
        sink = new MemorySink()
        host = new ContractHost()
        new EntitlementReceiver(credential, sink).MountOn(host.Routes)
        await host.Start()
    })

    afterEach(async () => await host.Stop())

    it('applies a newer statement and ignores an equal or older one', async () =>
    {
        const sender = new EntitlementSender(host.BaseUrl, credential)
        assert.deepEqual((await sender.Send(Samples.Statement(2))).ToJson(), { Outcome: ReceiptOutcome.Applied, CurrentVersion: 2 })
        assert.deepEqual((await sender.Send(Samples.Statement(2))).ToJson(), { Outcome: ReceiptOutcome.Duplicate, CurrentVersion: 2 })
        assert.deepEqual((await sender.Send(Samples.Statement(1))).ToJson(), { Outcome: ReceiptOutcome.Stale, CurrentVersion: 2 })
        assert.deepEqual((await sender.Send(Samples.Statement(5))).ToJson(), { Outcome: ReceiptOutcome.Applied, CurrentVersion: 5 })
        assert.deepEqual(sink.Applied.map(statement => statement.Version), [2, 5])
    })

    it('keeps the versions of each client apart', async () =>
    {
        const sender = new EntitlementSender(host.BaseUrl, credential)
        await sender.Send(Samples.Statement(9, 'acme'))
        assert.equal((await sender.Send(Samples.Statement(1, 'globex'))).Outcome, ReceiptOutcome.Applied)
    })

    it('handles concurrent statements of one client one at a time, so an older one never overwrites a newer one', async () =>
    {
        const sender = new EntitlementSender(host.BaseUrl, credential)
        const receipts = await Promise.all([3, 1, 2, 4, 3].map(version => sender.Send(Samples.Statement(version))))
        const applied = sink.Applied.map(statement => statement.Version)
        assert.deepEqual(applied, [...applied].sort((a, b) => a - b))
        assert.equal(new Set(applied).size, applied.length)
        assert.equal(applied.at(-1), 4)
        assert.equal(receipts.filter(receipt => receipt.Outcome === ReceiptOutcome.Applied).length, applied.length)
    })

    it('refuses a sender without the link bearer (another link on the same secret included)', async () =>
    {
        const wrong = new EntitlementSender(host.BaseUrl, EntitlementsLink.CredentialFromSecret(Buffer.alloc(32, 6)))
        await assert.rejects(wrong.Send(Samples.Statement(1)), (err: unknown) => err instanceof EntitlementDeliveryError && err.Status === 401 && err.Code === 'unauthorized')
        assert.equal(sink.Applied.length, 0)
    })

    it('answers a malformed statement 400 invalid-request', async () =>
    {
        const receiver = new EntitlementReceiver(credential, sink)
        await assert.rejects(receiver.Receive(credential.AuthorizationValue(), Samples.Json({ Version: -1 })), (err: unknown) => err instanceof BadRequestProblem && err.Code === 'invalid-request')
        await assert.rejects(receiver.Receive(undefined, Samples.Json()), (err: unknown) => err instanceof HttpProblem && err.Status === 401)
    })

    it('reports an unreachable receiver as unavailable', async () =>
    {
        const sender = new EntitlementSender('http://127.0.0.1:1', credential, 500)
        await assert.rejects(sender.Send(Samples.Statement(1)), (err: unknown) => err instanceof EntitlementDeliveryError && err.Code === 'unavailable' && err.Status === 0)
    })
})
