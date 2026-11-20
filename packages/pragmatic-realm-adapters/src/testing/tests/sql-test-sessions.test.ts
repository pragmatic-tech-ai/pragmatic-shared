import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '../sql-test-sessions.js'

test('Describe invokes the body once for pg-mem when the live env var is unset', () =>
{
    const saved = process.env.PRAGMATIC_TEST_PG_URL
    delete process.env.PRAGMATIC_TEST_PG_URL
    try
    {
        const backends: string[] = []
        SqlTestSessions.Describe('X', (_makeSession, backend) =>
        {
            backends.push(backend)
        })
        assert.equal(backends.length, 1)
        assert.ok(backends[0]!.endsWith('[pg-mem]'))
    }
    finally
    {
        if (saved !== undefined) process.env.PRAGMATIC_TEST_PG_URL = saved
    }
})

test('DescribeLive registers nothing when the live env var is unset', () =>
{
    const saved = process.env.PRAGMATIC_TEST_PG_URL
    delete process.env.PRAGMATIC_TEST_PG_URL
    try
    {
        let called = 0
        SqlTestSessions.DescribeLive('X', () =>
        {
            called++
        })
        assert.equal(called, 0)
    }
    finally
    {
        if (saved !== undefined) process.env.PRAGMATIC_TEST_PG_URL = saved
    }
})

test('the pg-mem pool answers pg_advisory_xact_lock (pg-mem runs one statement at a time)', async () =>
{
    const pool = SqlTestSessions.MemPool()
    const result = await pool.query('SELECT pg_advisory_xact_lock($1)', [1])
    assert.equal(result.rows.length, 1)
})

SqlTestSessions.DescribeLive('SqlTestSessions', makeDatabase =>
{
    test('SqlTestSessions [live]: each database is its own schema, and its sessions share it', async () =>
    {
        const first = await makeDatabase()
        const second = await makeDatabase()
        await first.Session().Execute('CREATE TABLE shared_probe (id text)', [])
        await first.Session().Execute('INSERT INTO shared_probe (id) VALUES ($1)', ['a'])
        assert.equal((await first.Session().Query('SELECT id FROM shared_probe', [])).length, 1)
        await assert.rejects(() => second.Session().Query('SELECT id FROM shared_probe', []))
        await first.Dispose()
        await second.Dispose()
    })
})
