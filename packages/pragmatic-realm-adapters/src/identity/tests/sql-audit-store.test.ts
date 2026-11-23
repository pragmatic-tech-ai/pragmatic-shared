import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AuditEvent, AuditEventKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { AuditTamperDetected } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { SqlAuditStore } from '../sql-audit-store.js'

SqlTestSessions.Describe('SqlAuditStore', (makeSession, backend) =>
{
    const event = (realm: string, detail: ReadonlyMap<string, string>) =>
        new AuditEvent(AuditEventKind.Authentication, realm, 'p1', new Date('2020-01-01T00:00:00Z'), detail)

    test(`${backend}: records chain and replay is deterministic across a reopen`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const first = await SqlAuditStore.Open(session)
        await first.Record(event(t, new Map([['a', '1']])))
        await first.Record(event(t, new Map([['b', '2']])))
        assert.equal(first.Verify(t), true)
        assert.equal(first.Records(t).length, 2)
        const beforeHashes = first.Records(t).map(r => r.Hash)
        const beforePrev = first.Records(t).map(r => r.PrevHash)
        const reopened = await SqlAuditStore.Open(session)
        assert.equal(reopened.Verify(t), true)
        assert.equal(reopened.Records(t).length, 2)
        assert.deepEqual(reopened.Records(t).map(r => r.Hash), beforeHashes)
        assert.deepEqual(reopened.Records(t).map(r => r.PrevHash), beforePrev)
    })

    test(`${backend}: null PrincipalId and multi-key Detail round-trip`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const first = await SqlAuditStore.Open(session)
        await first.Record(new AuditEvent(AuditEventKind.Authentication, t, null, new Date('2020-01-01T00:00:00Z'), new Map([['a', '1'], ['b', '2']])))
        const reopened = await SqlAuditStore.Open(session)
        const recs = reopened.Records(t)
        assert.equal(recs.length, 1)
        assert.equal(recs[0]!.Event.PrincipalId, null)
        assert.deepEqual([...recs[0]!.Event.Detail], [['a', '1'], ['b', '2']])
        assert.equal(reopened.Verify(t), true)
    })

    test(`${backend}: distinct realms keep independent chains`, async () =>
    {
        const session = await makeSession()
        const store = await SqlAuditStore.Open(session)
        const ta = `audit-${randomUUID()}`
        const tb = `audit-${randomUUID()}`
        await store.Record(event(ta, new Map()))
        await store.Record(event(tb, new Map()))
        await store.Record(event(ta, new Map([['x', '1']])))
        assert.equal(store.Records(ta).length, 2)
        assert.equal(store.Records(tb).length, 1)
        const rowsA = await session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [ta])
        const rowsB = await session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [tb])
        assert.deepEqual(rowsA.map(r => Number(r.seq)), [0, 1])
        assert.deepEqual(rowsB.map(r => Number(r.seq)), [0])
        const reopened = await SqlAuditStore.Open(session)
        assert.equal(reopened.Verify(ta), true)
        assert.equal(reopened.Verify(tb), true)
    })

    test(`${backend}: hash and prev_hash are persisted and equal the chain`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map([['a', '1']])))
        await store.Record(event(t, new Map([['b', '2']])))
        const rows = await session.Query('SELECT hash, prev_hash FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.equal(rows.length, 2)
        assert.deepEqual(rows.map(r => String(r.hash)), store.Records(t).map(r => r.Hash))
        assert.deepEqual(rows.map(r => String(r.prev_hash)), store.Records(t).map(r => r.PrevHash))
    })

    test(`${backend}: tampered detail makes Open throw AuditTamperDetected`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map([['a', '1']])))
        await store.Record(event(t, new Map([['b', '2']])))
        await session.Execute('UPDATE identity_audit SET detail = $1 WHERE realm_id = $2 AND seq = 0', [JSON.stringify([['a', 'evil']]), t])
        await assert.rejects(() => SqlAuditStore.Open(session), AuditTamperDetected)
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })

    test(`${backend}: tampered seq makes Open throw`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map()))
        await store.Record(event(t, new Map([['b', '2']])))
        await session.Execute('UPDATE identity_audit SET seq = 5 WHERE realm_id = $1 AND seq = 1', [t])
        await assert.rejects(() => SqlAuditStore.Open(session), AuditTamperDetected)
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })

    test(`${backend}: mid-chain delete (seq gap) makes Open throw`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map([['a', '1']])))
        await store.Record(event(t, new Map([['b', '2']])))
        await store.Record(event(t, new Map([['c', '3']])))
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1 AND seq = 1', [t])
        await assert.rejects(() => SqlAuditStore.Open(session), AuditTamperDetected)
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })

    test(`${backend}: legacy NULL-hash rows are backfilled on Open`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        await SqlAuditStore.Open(session)
        for (let i = 0; i < 2; i++)
        {
            await session.Execute('INSERT INTO identity_audit (realm_id, seq, kind, principal_id, at, detail, hash, prev_hash) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)', [t, i, AuditEventKind.Authentication, 'p1', '2020-01-01T00:00:00.000Z', JSON.stringify([['n', String(i)]])])
        }
        const first = await SqlAuditStore.Open(session)
        assert.equal(first.Verify(t), true)
        const rows = await session.Query('SELECT hash, prev_hash FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.ok(rows.every(r => r.hash !== null && r.prev_hash !== null))
        const second = await SqlAuditStore.Open(session)
        assert.equal(second.Verify(t), true)
        assert.deepEqual(second.Records(t).map(r => r.Hash), first.Records(t).map(r => r.Hash))
    })

    test(`${backend}: concurrent Record for one realm stays contiguous and verifiable`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        const n = 12
        await Promise.all(Array.from({ length: n }, (_, i) => store.Record(event(t, new Map([['i', String(i)]])))))
        const rows = await session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.deepEqual(rows.map(r => Number(r.seq)), Array.from({ length: n }, (_, i) => i))
        assert.equal(store.Records(t).length, n)
        assert.equal(store.Verify(t), true)
        const reopened = await SqlAuditStore.Open(session)
        assert.equal(reopened.Verify(t), true)
    })

    test(`${backend}: two store instances over one database writing one realm alternately both succeed`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const a = await SqlAuditStore.Open(session)
        const b = await SqlAuditStore.Open(session)
        for (let i = 0; i < 6; i++)
        {
            await (i % 2 === 0 ? a : b).Record(event(t, new Map([['i', String(i)]])))
        }
        const rows = await session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.deepEqual(rows.map(r => Number(r.seq)), [0, 1, 2, 3, 4, 5])
        assert.equal(b.Records(t).length, 6)
        assert.equal(b.Verify(t), true)
        assert.equal(a.Records(t).length, 5)
        await a.Refresh(t)
        assert.equal(a.Records(t).length, 6)
        assert.equal(a.Verify(t), true)
        assert.deepEqual(a.Records(t).map(r => r.Hash), b.Records(t).map(r => r.Hash))
        const reopened = await SqlAuditStore.Open(session)
        assert.equal(reopened.Verify(t), true)
        assert.deepEqual(reopened.Records(t).map(r => r.Hash), b.Records(t).map(r => r.Hash))
    })

    test(`${backend}: the chain an instance writes after another instance matches a single-writer chain byte for byte`, async () =>
    {
        const t = `audit-${randomUUID()}`
        const events = [event(t, new Map([['a', '1']])), event(t, new Map([['b', '2']])), event(t, new Map([['c', '3']]))]
        const solo = await SqlAuditStore.Open(await makeSession())
        for (const e of events)
        {
            await solo.Record(e)
        }
        const shared = await makeSession()
        const a = await SqlAuditStore.Open(shared)
        const b = await SqlAuditStore.Open(shared)
        await a.Record(events[0]!)
        await b.Record(events[1]!)
        await a.Record(events[2]!)
        assert.deepEqual(a.Records(t).map(r => r.Hash), solo.Records(t).map(r => r.Hash))
        assert.deepEqual(a.Records(t).map(r => r.PrevHash), solo.Records(t).map(r => r.PrevHash))
    })

    test(`${backend}: a row another writer tampered with is caught when an instance catches up`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const a = await SqlAuditStore.Open(session)
        const b = await SqlAuditStore.Open(session)
        await a.Record(event(t, new Map([['a', '1']])))
        await b.Record(event(t, new Map([['b', '2']])))
        await session.Execute('UPDATE identity_audit SET detail = $1 WHERE realm_id = $2 AND seq = 1', [JSON.stringify([['b', 'evil']]), t])
        await assert.rejects(() => a.Record(event(t, new Map([['c', '3']]))), AuditTamperDetected)
        await assert.rejects(() => a.Refresh(t), AuditTamperDetected)
        const rows = await session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.deepEqual(rows.map(r => Number(r.seq)), [0, 1])
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })

    test(`${backend}: a deleted head row is caught by the next write`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map([['a', '1']])))
        await store.Record(event(t, new Map([['b', '2']])))
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1 AND seq = 1', [t])
        await assert.rejects(() => store.Record(event(t, new Map([['c', '3']]))), AuditTamperDetected)
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })

    test(`${backend}: the realm lock key is a stable non-negative bigint per realm`, () =>
    {
        const key = SqlAuditStore.LockKey('realm-a')
        assert.equal(key, SqlAuditStore.LockKey('realm-a'))
        assert.notEqual(key, SqlAuditStore.LockKey('realm-b'))
        assert.ok(BigInt(key) >= 0n && BigInt(key) < 2n ** 63n)
    })

    test(`${backend}: nulling a hash after hashed rows is tamper, not a backfill`, async () =>
    {
        const session = await makeSession()
        const t = `audit-${randomUUID()}`
        const store = await SqlAuditStore.Open(session)
        await store.Record(event(t, new Map([['a', '1']])))
        await store.Record(event(t, new Map([['b', '2']])))
        await store.Record(event(t, new Map([['c', '3']])))
        await session.Execute('UPDATE identity_audit SET hash = NULL, prev_hash = NULL, detail = $1 WHERE realm_id = $2 AND seq = 1', [JSON.stringify([['b', 'evil']]), t])
        await assert.rejects(() => SqlAuditStore.Open(session), AuditTamperDetected)
        await session.Execute('DELETE FROM identity_audit WHERE realm_id = $1', [t])
    })
})

SqlTestSessions.DescribeLive('SqlAuditStore', makeDatabase =>
{
    test('SqlAuditStore [live]: 8 concurrent writers across instances land with consecutive seqs and a valid chain', async () =>
    {
        const database = await makeDatabase()
        const t = `audit-${randomUUID()}`
        const stores = await Promise.all(Array.from({ length: 8 }, () => SqlAuditStore.Open(database.Session())))
        const rounds = 3
        await Promise.all(stores.flatMap((store, s) => Array.from({ length: rounds }, (_, r) =>
            store.Record(new AuditEvent(AuditEventKind.Authentication, t, `p${s}`, new Date('2020-01-01T00:00:00Z'), new Map([['r', String(r)]]))))))
        const total = stores.length * rounds
        const rows = await database.Session().Query('SELECT seq FROM identity_audit WHERE realm_id = $1 ORDER BY seq', [t])
        assert.deepEqual(rows.map(r => Number(r.seq)), Array.from({ length: total }, (_, i) => i))
        for (const store of stores)
        {
            await store.Refresh(t)
            assert.equal(store.Records(t).length, total)
            assert.equal(store.Verify(t), true)
        }
        const reopened = await SqlAuditStore.Open(database.Session())
        assert.equal(reopened.Verify(t), true)
        assert.deepEqual(reopened.Records(t).map(r => r.Hash), stores[0]!.Records(t).map(r => r.Hash))
        await database.Dispose()
    })
})
