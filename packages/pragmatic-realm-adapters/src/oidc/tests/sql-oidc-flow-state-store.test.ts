import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { OidcFlowState } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlOidcFlowStateMigrations, SqlOidcFlowStateStore } from '../sql-oidc-flow-state-store.js'
import { SqlMigrationModule } from '../../sql/sql-migration.js'
import type { SqlMigration } from '../../sql/sql-migration.js'
import { SqlMigrationRunner } from '../../sql/sql-migration-runner.js'

class FlowClock
{
    public At = new Date('2026-11-20T10:00:00.000Z')

    public readonly Now = (): Date => this.At

    public Advance(ms: number): void
    {
        this.At = new Date(this.At.getTime() + ms)
    }

    public State(ttlMs: number): OidcFlowState
    {
        return new OidcFlowState(`st-${randomUUID()}`, 'nonce-1', 'verifier-1', 'https://app.example/callback', new Date(this.At.getTime() + ttlMs))
    }
}

/** The flow-state module as it shipped before the return path: its first migration only. */
class FirstSchemaOnly extends SqlMigrationModule
{
    public readonly Name = new SqlOidcFlowStateMigrations().Name

    public Migrations(): readonly SqlMigration[]
    {
        return new SqlOidcFlowStateMigrations().Migrations().slice(0, 1)
    }
}

SqlTestSessions.Describe('SqlOidcFlowStateStore', (makeSession, backend) =>
{
    test(`${backend}: Put then Take returns every field`, async () =>
    {
        const clock = new FlowClock()
        const store = await SqlOidcFlowStateStore.Open(await makeSession(), clock.Now)
        const state = clock.State(60_000)
        await store.Put(state)
        const taken = await store.Take(state.State)
        assert.deepEqual(taken, state)
    })

    test(`${backend}: a state is single use`, async () =>
    {
        const clock = new FlowClock()
        const store = await SqlOidcFlowStateStore.Open(await makeSession(), clock.Now)
        const state = clock.State(60_000)
        await store.Put(state)
        assert.notEqual(await store.Take(state.State), null)
        assert.equal(await store.Take(state.State), null)
    })

    test(`${backend}: an unknown state is null`, async () =>
    {
        const store = await SqlOidcFlowStateStore.Open(await makeSession())
        assert.equal(await store.Take('nope'), null)
    })

    test(`${backend}: an expired state is null and consumed`, async () =>
    {
        const clock = new FlowClock()
        const session = await makeSession()
        const store = await SqlOidcFlowStateStore.Open(session, clock.Now)
        const state = clock.State(1_000)
        await store.Put(state)
        clock.Advance(1_000)
        assert.equal(await store.Take(state.State), null)
        assert.equal((await session.Query('SELECT state FROM oidc_flow_states WHERE state = $1', [state.State])).length, 0)
    })

    test(`${backend}: Put sweeps expired states left behind by abandoned sign-ins`, async () =>
    {
        const clock = new FlowClock()
        const session = await makeSession()
        const store = await SqlOidcFlowStateStore.Open(session, clock.Now)
        const abandoned = clock.State(1_000)
        await store.Put(abandoned)
        clock.Advance(5_000)
        await store.Put(clock.State(60_000))
        assert.equal((await session.Query('SELECT state FROM oidc_flow_states WHERE state = $1', [abandoned.State])).length, 0)
    })

    test(`${backend}: the return path round-trips, and a flow without one reads as null`, async () =>
    {
        const clock = new FlowClock()
        const store = await SqlOidcFlowStateStore.Open(await makeSession(), clock.Now)
        const plain = clock.State(60_000)
        const returning = new OidcFlowState(`st-${randomUUID()}`, 'nonce-2', 'verifier-2', 'https://app.example/callback', plain.ExpiresAt, '/register?step=2')
        await store.Put(plain)
        await store.Put(returning)
        assert.equal((await store.Take(plain.State))?.ReturnPath, null)
        assert.deepEqual(await store.Take(returning.State), returning)
    })

    test(`${backend}: a schema at version 1 gains the return path column (rows put before it read as null)`, async () =>
    {
        const clock = new FlowClock()
        const session = await makeSession()
        await SqlMigrationRunner.Run(session, new FirstSchemaOnly())
        const old = clock.State(60_000)
        await session.Execute('INSERT INTO oidc_flow_states (state, nonce, code_verifier, redirect_uri, expires_at) VALUES ($1, $2, $3, $4, $5)', [old.State, old.Nonce, old.CodeVerifier, old.RedirectUri, old.ExpiresAt])
        const store = await SqlOidcFlowStateStore.Open(session, clock.Now)
        assert.deepEqual(await store.Take(old.State), old)
        const returning = new OidcFlowState(`st-${randomUUID()}`, 'n', 'v', 'https://app.example/callback', old.ExpiresAt, '/register')
        await store.Put(returning)
        assert.equal((await store.Take(returning.State))?.ReturnPath, '/register')
    })

    test(`${backend}: a state survives a restart (another store over the same database)`, async () =>
    {
        const clock = new FlowClock()
        const session = await makeSession()
        const state = clock.State(60_000)
        await (await SqlOidcFlowStateStore.Open(session, clock.Now)).Put(state)
        assert.deepEqual(await (await SqlOidcFlowStateStore.Open(session, clock.Now)).Take(state.State), state)
    })
})

SqlTestSessions.DescribeLive('SqlOidcFlowStateStore', makeDatabase =>
{
    test('SqlOidcFlowStateStore [live]: concurrent Takes of one state - exactly one wins', async () =>
    {
        const database = await makeDatabase()
        const clock = new FlowClock()
        const store = await SqlOidcFlowStateStore.Open(database.Session(), clock.Now)
        const state = clock.State(60_000)
        await store.Put(state)
        const racers = await Promise.all(Array.from({ length: 8 }, async () => (await SqlOidcFlowStateStore.Open(database.Session(), clock.Now)).Take(state.State)))
        assert.equal(racers.filter(r => r !== null).length, 1)
        await database.Dispose()
    })
})
