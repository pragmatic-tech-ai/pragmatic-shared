import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PgSession } from '../../sql/pg-session.js'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlRecordStore, SqlRecordUpdateContentionError, SqlRecordVersionConflictError } from '../sql-record-store.js'

type Hive = { id: string, name: string, tags: string[], count?: number }

class RecordClock
{
    private at = Date.parse('2026-11-20T10:00:00.000Z')

    public readonly Now = (): Date => new Date(this.at)

    public Tick(): void
    {
        this.at += 1_000
    }
}

test('a registry name must be a lower-case SQL identifier', async () =>
{
    const session = new PgSession(SqlTestSessions.MemPool())
    for (const bad of ['', 'Hives', 'hives;drop', '1hives', 'h-ives', 'x'.repeat(49)])
    {
        await assert.rejects(() => SqlRecordStore.Open<Hive>(session, bad), /registry name/)
    }
})

SqlTestSessions.Describe('SqlRecordStore', (makeSession, backend) =>
{
    test(`${backend}: Put then Get; an absent id is undefined`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await store.Put({ id: 'h1', name: 'one', tags: ['a'] })
        assert.deepEqual(await store.Get('h1'), { id: 'h1', name: 'one', tags: ['a'] })
        assert.equal(await store.Get('h2'), undefined)
    })

    test(`${backend}: Get hands out a copy`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await store.Put({ id: 'h1', name: 'one', tags: ['a'] })
        const got = (await store.Get('h1'))!
        got.tags.push('mutated')
        assert.deepEqual((await store.Get('h1'))!.tags, ['a'])
    })

    test(`${backend}: Put replaces the record and bumps its version`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        assert.equal(await store.Put({ id: 'h1', name: 'one', tags: [] }), 1)
        assert.equal(await store.Put({ id: 'h1', name: 'uno', tags: [] }), 2)
        const versioned = (await store.GetVersioned('h1'))!
        assert.equal(versioned.Version, 2)
        assert.equal(versioned.Record.name, 'uno')
    })

    test(`${backend}: List returns every record ordered by id`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await store.Put({ id: 'b', name: 'B', tags: [] })
        await store.Put({ id: 'a', name: 'A', tags: [] })
        await store.Put({ id: 'c', name: 'C', tags: [] })
        assert.deepEqual((await store.List()).map(r => r.id), ['a', 'b', 'c'])
    })

    test(`${backend}: ListPrefix returns the records whose id starts with the prefix, ordered by id`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        for (const id of ['envb/x', 'enva/z', 'enva/y', 'env', 'other/enva/q', 'envab/w'])
        {
            await store.Put({ id, name: id, tags: [] })
        }
        assert.deepEqual((await store.ListPrefix('enva/')).map(r => r.id), ['enva/y', 'enva/z'])
        assert.deepEqual((await store.ListPrefix('nothing')).map(r => r.id), [])
        assert.equal((await store.ListPrefix('')).length, 6)
    })

    test(`${backend}: ListPrefix takes _, % and backslash literally`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        for (const id of ['a_b/1', 'axb/1', 'a%b/1', 'a%%b/1', 'aq/1', 'a\\b/1', 'ab/1'])
        {
            await store.Put({ id, name: id, tags: [] })
        }
        assert.deepEqual((await store.ListPrefix('a_b/')).map(r => r.id), ['a_b/1'])
        assert.deepEqual((await store.ListPrefix('a%b/')).map(r => r.id), ['a%b/1'])
        assert.deepEqual((await store.ListPrefix('a%')).map(r => r.id).sort(), ['a%%b/1', 'a%b/1'])
        assert.deepEqual((await store.ListPrefix('a\\b')).map(r => r.id), ['a\\b/1'])
        assert.deepEqual((await store.ListPrefix('a_')).map(r => r.id), ['a_b/1'])
    })

    test(`${backend}: Delete reports whether the record existed`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await store.Put({ id: 'h1', name: 'one', tags: [] })
        assert.equal(await store.Delete('h1'), true)
        assert.equal(await store.Delete('h1'), false)
        assert.equal(await store.Get('h1'), undefined)
    })

    test(`${backend}: registries are separate tables and records survive a reopen`, async () =>
    {
        const session = await makeSession()
        const hives = await SqlRecordStore.Open<Hive>(session, 'hives')
        const tenants = await SqlRecordStore.Open<Hive>(session, 'tenants')
        await hives.Put({ id: 'x', name: 'hive', tags: [] })
        await tenants.Put({ id: 'x', name: 'tenant', tags: [] })
        assert.equal((await (await SqlRecordStore.Open<Hive>(session, 'hives')).Get('x'))!.name, 'hive')
        assert.equal((await tenants.Get('x'))!.name, 'tenant')
        const recorded = await session.Query('SELECT module, version FROM schema_migrations WHERE module LIKE $1 ORDER BY module', ['records.%'])
        assert.deepEqual(recorded.map(r => [r.module, Number(r.version)]), [['records.hives', 1], ['records.tenants', 1]])
    })

    test(`${backend}: PutIfVersion inserts at 0, replaces at the current version and refuses a stale one`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        assert.equal(await store.PutIfVersion({ id: 'h1', name: 'one', tags: [] }, 0), 1)
        await assert.rejects(() => store.PutIfVersion({ id: 'h1', name: 'again', tags: [] }, 0), SqlRecordVersionConflictError)
        assert.equal(await store.PutIfVersion({ id: 'h1', name: 'two', tags: [] }, 1), 2)
        await assert.rejects(() => store.PutIfVersion({ id: 'h1', name: 'stale', tags: [] }, 1), (err: unknown) =>
            err instanceof SqlRecordVersionConflictError && err.Id === 'h1' && err.ExpectedVersion === 1)
        assert.equal((await store.Get('h1'))!.name, 'two')
    })

    test(`${backend}: Update creates, changes and (returning undefined) deletes`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        const created = await store.Update('h1', current => current ?? { id: 'h1', name: 'new', tags: [] })
        assert.deepEqual(created, { id: 'h1', name: 'new', tags: [] })
        await store.Update('h1', current => ({ ...current!, tags: [...current!.tags, 't'] }))
        assert.deepEqual((await store.Get('h1'))!.tags, ['t'])
        assert.equal(await store.Update('h1', () => undefined), undefined)
        assert.equal(await store.Get('h1'), undefined)
        assert.equal(await store.Update('absent', () => undefined), undefined)
    })

    test(`${backend}: Update refuses a result with another id`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await assert.rejects(() => store.Update('h1', () => ({ id: 'h2', name: 'x', tags: [] })), /id/)
    })

    test(`${backend}: concurrent Updates of one record all land (optimistic retry)`, async () =>
    {
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'hives')
        await store.Put({ id: 'c', name: 'counter', tags: [], count: 0 })
        await Promise.all(Array.from({ length: 10 }, () => store.Update('c', current => ({ ...current!, count: current!.count! + 1 }))))
        assert.equal((await store.Get('c'))!.count, 10)
    })

    test(`${backend}: Update gives up with a contention error once its attempts run out`, async () =>
    {
        const session = await makeSession()
        const store = await SqlRecordStore.Open<Hive>(session, 'hives', { MaxUpdateAttempts: 2 })
        await store.Put({ id: 'c', name: 'counter', tags: [], count: 0 })
        const rival = await SqlRecordStore.Open<Hive>(session, 'hives')
        await assert.rejects(() => store.Update('c', async current =>
        {
            await rival.Put({ ...current!, count: current!.count! + 100 })
            return { ...current!, count: current!.count! + 1 }
        }), SqlRecordUpdateContentionError)
    })

    test(`${backend}: RetainNewest keeps only the newest N records by last write`, async () =>
    {
        const clock = new RecordClock()
        const store = await SqlRecordStore.Open<Hive>(await makeSession(), 'audit', { RetainNewest: 3, Now: clock.Now })
        for (const id of ['e1', 'e2', 'e3', 'e4', 'e5'])
        {
            await store.Put({ id, name: id, tags: [] })
            clock.Tick()
        }
        assert.deepEqual((await store.List()).map(r => r.id), ['e3', 'e4', 'e5'])
        await store.Put({ id: 'e3', name: 'touched', tags: [] })
        clock.Tick()
        await store.Put({ id: 'e6', name: 'e6', tags: [] })
        assert.deepEqual((await store.List()).map(r => r.id), ['e3', 'e5', 'e6'])
    })
})

SqlTestSessions.DescribeLive('SqlRecordStore', makeDatabase =>
{
    test('SqlRecordStore [live]: concurrent Updates from separate connections all land', async () =>
    {
        const database = await makeDatabase()
        const seed = await SqlRecordStore.Open<Hive>(database.Session(), 'hives')
        await seed.Put({ id: 'c', name: 'counter', tags: [], count: 0 })
        const stores = await Promise.all(Array.from({ length: 6 }, () => SqlRecordStore.Open<Hive>(database.Session(), 'hives')))
        await Promise.all(stores.flatMap(store => [1, 2, 3].map(() => store.Update('c', current => ({ ...current!, count: current!.count! + 1 })))))
        assert.equal((await seed.Get('c'))!.count, 18)
        await database.Dispose()
    })
})
