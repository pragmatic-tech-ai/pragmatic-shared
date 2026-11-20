import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SecretStoreConformance } from '@pragmatic-tech-ai/pragmatic-identity/testing'
import type { ISecretStoreConformanceFixture } from '@pragmatic-tech-ai/pragmatic-identity/testing'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlSecretKeyRing, SqlSecretStore } from '../sql-secret-store.js'

class SqlSecretFixture implements ISecretStoreConformanceFixture
{
    public constructor(private readonly session: ISqlSession, private readonly scope: string)
    {
    }

    public Open(masterKey: Buffer): Promise<ISecretStore>
    {
        return SqlSecretStore.Open(this.session, SqlSecretKeyRing.Single('k1', masterKey), this.scope)
    }

    public async RawContents(): Promise<string>
    {
        return JSON.stringify(await this.session.Query('SELECT * FROM sealed_secrets WHERE scope = $1', [this.scope]))
    }
}

class SecretRows
{
    public static async Row(session: ISqlSession, scope: string, reference: string): Promise<Record<string, unknown>>
    {
        const rows = await session.Query('SELECT key_id, nonce, tag, ciphertext FROM sealed_secrets WHERE scope = $1 AND reference = $2', [scope, reference])
        return { ...rows[0]! }
    }

    /** Copies one row's sealed bytes onto another (scope, reference): what an attacker with table access could do. */
    public static async Transplant(session: ISqlSession, from: { scope: string, reference: string }, to: { scope: string, reference: string }): Promise<void>
    {
        const row = await SecretRows.Row(session, from.scope, from.reference)
        await session.Execute('INSERT INTO sealed_secrets (scope, reference, key_id, nonce, tag, ciphertext, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())', [to.scope, to.reference, row.key_id, row.nonce, row.tag, row.ciphertext])
    }
}

test('a key ring refuses a key that is not 32 bytes, an unknown current id and an empty id', () =>
{
    assert.throws(() => SqlSecretKeyRing.Single('k1', randomBytes(16)), /32 bytes/)
    assert.throws(() => new SqlSecretKeyRing('k2', new Map([['k1', randomBytes(32)]])), /current key/)
    assert.throws(() => SqlSecretKeyRing.Single('', randomBytes(32)), /key id/)
})

SqlTestSessions.Describe('SqlSecretStore', (makeSession, backend) =>
{
    SecretStoreConformance.Describe(`${backend} conformance`, async () => new SqlSecretFixture(await makeSession(), `scope-${randomUUID()}`))

    test(`${backend}: each Put draws a fresh nonce and records the current key id`, async () =>
    {
        const session = await makeSession()
        const store = await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('k1', randomBytes(32)), 's')
        await store.Put('a', 'same')
        const first = await SecretRows.Row(session, 's', 'a')
        await store.Put('a', 'same')
        const second = await SecretRows.Row(session, 's', 'a')
        assert.equal(second.key_id, 'k1')
        assert.notEqual(first.nonce, second.nonce)
        assert.notEqual(first.ciphertext, second.ciphertext)
    })

    test(`${backend}: a sealed row moved to another reference or scope does not open (bound by associated data)`, async () =>
    {
        const session = await makeSession()
        const ring = SqlSecretKeyRing.Single('k1', randomBytes(32))
        const store = await SqlSecretStore.Open(session, ring, 'realm-a')
        await store.Put('db-password', 'p4ss')
        await SecretRows.Transplant(session, { scope: 'realm-a', reference: 'db-password' }, { scope: 'realm-a', reference: 'other' })
        await SecretRows.Transplant(session, { scope: 'realm-a', reference: 'db-password' }, { scope: 'realm-b', reference: 'db-password' })
        assert.equal(await store.Get('other'), null)
        assert.equal(await (await SqlSecretStore.Open(session, ring, 'realm-b')).Get('db-password'), null)
        assert.equal(await store.Get('db-password'), 'p4ss')
    })

    test(`${backend}: scopes are isolated`, async () =>
    {
        const session = await makeSession()
        const ring = SqlSecretKeyRing.Single('k1', randomBytes(32))
        const a = await SqlSecretStore.Open(session, ring, 'realm-a')
        const b = await SqlSecretStore.Open(session, ring, 'realm-b')
        await a.Put('ref', 'for a')
        assert.equal(await b.Get('ref'), null)
        await b.Delete('ref')
        assert.equal(await a.Get('ref'), 'for a')
    })

    test(`${backend}: rotation - older keys still open their rows, Rekey moves every row of the scope to the current key`, async () =>
    {
        const session = await makeSession()
        const k1 = randomBytes(32)
        const k2 = randomBytes(32)
        await (await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('k1', k1), 's')).Put('ref', 'rotate me')
        const rotated = await SqlSecretStore.Open(session, new SqlSecretKeyRing('k2', new Map([['k1', k1], ['k2', k2]])), 's')
        assert.equal(await rotated.Get('ref'), 'rotate me')
        assert.equal(await rotated.Rekey(), 1)
        assert.equal((await SecretRows.Row(session, 's', 'ref')).key_id, 'k2')
        assert.equal(await rotated.Rekey(), 0)
        assert.equal(await (await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('k2', k2), 's')).Get('ref'), 'rotate me')
    })

    test(`${backend}: a row sealed under a key id the ring does not hold reads as null`, async () =>
    {
        const session = await makeSession()
        await (await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('old', randomBytes(32)), 's')).Put('ref', 'x')
        assert.equal(await (await SqlSecretStore.Open(session, SqlSecretKeyRing.Single('new', randomBytes(32)), 's')).Get('ref'), null)
    })
})
