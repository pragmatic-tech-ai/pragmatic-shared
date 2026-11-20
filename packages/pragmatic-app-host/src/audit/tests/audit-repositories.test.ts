import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AuditEntry } from '../audit-entry.js'
import { InMemoryAuditRepository } from '../audit-repository.js'
import type { IAuditRepository } from '../audit-repository.js'
import { SqlAuditRepository } from '../sql-audit-repository.js'

class AuditFixture
{
    public static readonly Actor = 'op@example.com'
    public static readonly Cap = 20
    public static readonly Extra = 3
    public static readonly BaseMs = Date.UTC(2026, 0, 1)

    public static Entry(n: number, actor: string = AuditFixture.Actor): AuditEntry
    {
        return AuditEntry.Create(actor, 'POST', '/api/x/' + n, 200, new Date(AuditFixture.BaseMs + n * 1000))
    }

    public static Anonymous(n: number): AuditEntry
    {
        return AuditFixture.Entry(n, AuditEntry.AnonymousActor)
    }

    public static Register(label: string, open: (cap: number) => Promise<IAuditRepository>): void
    {
        const F = AuditFixture
        test(`${label}: Recent returns newest first, limited, with every field`, async () =>
        {
            const repository = await open(F.Cap)
            for (const n of [1, 3, 2])
            {
                await repository.Append(F.Entry(n))
            }
            const noted = AuditEntry.Create(F.Actor, 'DELETE', '/api/hives/h1', 204, new Date(F.BaseMs + 9000), 'kept: 2 volumes')
            await repository.Append(noted)
            const recent = await repository.Recent(3)
            assert.deepEqual(recent.map(r => r.Target), ['/api/hives/h1', '/api/x/3', '/api/x/2'])
            assert.deepEqual(recent[0], noted)
        })

        test(`${label}: each entry has a unique non-empty id`, async () =>
        {
            const repository = await open(F.Cap)
            for (let n = 0; n < 5; n++)
            {
                await repository.Append(F.Entry(n))
            }
            const ids = (await repository.Recent(10)).map(r => r.Id)
            assert.equal(new Set(ids).size, 5)
            assert.ok(ids.every(id => id.length > 0))
        })

        test(`${label}: an anonymous flood never evicts authored history`, async () =>
        {
            const repository = await open(F.Cap)
            await repository.Append(F.Entry(0))
            for (let n = 1; n <= F.Cap; n++)
            {
                await repository.Append(F.Anonymous(n))
            }
            const all = await repository.Recent(1000)
            const targets = new Set(all.map(r => r.Target))
            assert.equal(all.length, F.Cap)
            assert.ok(targets.has('/api/x/0'))
            assert.ok(!targets.has('/api/x/1'))
        })

        test(`${label}: an all-authored overflow stays bounded, dropping the oldest`, async () =>
        {
            const repository = await open(F.Cap)
            const total = F.Cap + F.Extra
            for (let n = 0; n < total; n++)
            {
                await repository.Append(F.Entry(n))
            }
            const all = await repository.Recent(1000)
            const targets = new Set(all.map(r => r.Target))
            assert.equal(all.length, F.Cap)
            for (let n = 0; n < F.Extra; n++)
            {
                assert.ok(!targets.has('/api/x/' + n))
            }
            assert.ok(targets.has('/api/x/' + (total - 1)))
        })

        test(`${label}: eviction goes by timestamp, not insertion order`, async () =>
        {
            const repository = await open(3)
            for (const n of [5, 1, 4, 2])
            {
                await repository.Append(F.Entry(n))
            }
            assert.deepEqual((await repository.Recent(10)).map(r => r.Target), ['/api/x/5', '/api/x/4', '/api/x/2'])
        })
    }
}

AuditFixture.Register('InMemoryAuditRepository', cap => Promise.resolve(new InMemoryAuditRepository(cap)))

SqlTestSessions.Describe('SqlAuditRepository', (makeSession, backend) =>
{
    AuditFixture.Register(backend, async cap => await SqlAuditRepository.Open(await makeSession(), cap))

    test(`${backend}: the trail survives a restart`, async () =>
    {
        const session = await makeSession()
        await (await SqlAuditRepository.Open(session)).Append(AuditFixture.Entry(1))
        assert.equal((await (await SqlAuditRepository.Open(session)).Recent(5)).length, 1)
    })
})
