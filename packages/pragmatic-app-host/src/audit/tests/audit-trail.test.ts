import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuditTrail } from '../audit-trail.js'
import { AuditEntry } from '../audit-entry.js'
import { InMemoryAuditRepository } from '../audit-repository.js'
import type { IAuditRepository } from '../audit-repository.js'

class HeldRepository implements IAuditRepository
{
    public readonly Inner = new InMemoryAuditRepository()
    public Fail = false
    private release: (() => void) | undefined
    private held: Promise<void> | undefined

    public Hold(): void
    {
        this.held = new Promise(resolve =>
        {
            this.release = resolve
        })
    }

    public Release(): void
    {
        this.release?.()
    }

    public async Append(entry: AuditEntry): Promise<void>
    {
        await this.held
        if (this.Fail)
        {
            throw new Error('audit store down: secret detail')
        }
        await this.Inner.Append(entry)
    }

    public Recent(limit: number): Promise<readonly AuditEntry[]>
    {
        return this.Inner.Recent(limit)
    }
}

test('Record appends actor, action, target, status, time and note', async () =>
{
    const repository = new InMemoryAuditRepository()
    const at = new Date('2026-11-20T10:00:00.000Z')
    const trail = new AuditTrail(repository, { Now: () => at, Log: () => undefined })
    await trail.Record('op@x', 'POST', '/api/hives', 201, 'created h1')
    const [entry] = await repository.Recent(1)
    assert.deepEqual([entry?.Actor, entry?.Action, entry?.Target, entry?.Status, entry?.At, entry?.Note], ['op@x', 'POST', '/api/hives', 201, at, 'created h1'])
})

test('a failing repository never throws out of Record; only the error name is logged', async () =>
{
    const repository = new HeldRepository()
    repository.Fail = true
    const logged: unknown[] = []
    const trail = new AuditTrail(repository, { Log: (...items) => logged.push(...items) })
    await trail.Record('op@x', 'POST', '/api/x', 200)
    assert.ok(logged.includes('Error'))
    assert.ok(!logged.some(item => String(item).includes('secret detail')))
})

test('an over-long target is truncated', async () =>
{
    const repository = new InMemoryAuditRepository()
    const trail = new AuditTrail(repository, { MaxTargetLength: 10, Log: () => undefined })
    await trail.Record('op@x', 'POST', '/api/' + 'x'.repeat(100), 200)
    assert.equal((await repository.Recent(1))[0]?.Target.length, 10)
})

test('Drain resolves only once every pending write has ended', async () =>
{
    const repository = new HeldRepository()
    repository.Hold()
    const trail = new AuditTrail(repository, { Log: () => undefined })
    void trail.Record('op@x', 'POST', '/api/x', 200)
    let drained = false
    const drain = trail.Drain().then(() =>
    {
        drained = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(drained, false)
    repository.Release()
    await drain
    assert.equal(drained, true)
    assert.equal((await repository.Recent(5)).length, 1)
})

test('the anonymous actor is a fixed sentinel', () =>
{
    assert.equal(AuditEntry.AnonymousActor, '(anonymous)')
})
