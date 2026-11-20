import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ISessionRepository } from '../../session/session-repository.js'
import { SessionRecord } from '../../session/session-record.js'
import { SessionClaims } from '../../session/session-claims.js'
import { SessionPolicy } from '../../session/session-policy.js'

/** Behaviour every ISessionRepository shares (in memory, Postgres). */
export class SessionRepositoryConformance
{
    private static readonly At = new Date('2026-11-20T10:00:00.000Z')

    public static Record(id: string, subject: string, ttlMs = 60_000, at: Date = SessionRepositoryConformance.At): SessionRecord
    {
        return new SessionRecord(id, subject, SessionClaims.From({ roles: ['a', 'b'], email: subject + '@x' }), at, new Date(at.getTime() + ttlMs), at, new SessionPolicy(ttlMs, 1000, 10 * ttlMs))
    }

    public static Register(label: string, open: () => Promise<ISessionRepository>): void
    {
        const C = SessionRepositoryConformance
        test(`${label}: Insert then Find returns every field; an unknown id is null`, async () =>
        {
            const repository = await open()
            const record = C.Record('id-1', 'alice')
            await repository.Insert(record)
            assert.deepEqual(await repository.Find('id-1'), record)
            assert.equal(await repository.Find('nope'), null)
        })

        test(`${label}: Delete removes one session and reports whether it existed`, async () =>
        {
            const repository = await open()
            await repository.Insert(C.Record('id-1', 'alice'))
            assert.equal(await repository.Delete('id-1'), true)
            assert.equal(await repository.Delete('id-1'), false)
            assert.equal(await repository.Find('id-1'), null)
        })

        test(`${label}: DeleteSubject ends every session of the subject, and only those`, async () =>
        {
            const repository = await open()
            await repository.Insert(C.Record('a1', 'alice'))
            await repository.Insert(C.Record('a2', 'alice'))
            await repository.Insert(C.Record('b1', 'bob'))
            assert.equal(await repository.DeleteSubject('alice'), 2)
            assert.equal(await repository.Find('a1'), null)
            assert.equal(await repository.Find('a2'), null)
            assert.notEqual(await repository.Find('b1'), null)
        })

        test(`${label}: DeleteSubjectWithClaim ends the subject's sessions carrying the claim value, and only those`, async () =>
        {
            const repository = await open()
            const at = C.At
            const scoped = (id: string, subject: string, tenants: string[]): SessionRecord => new SessionRecord(id, subject, SessionClaims.From({ tenant: tenants }), at, new Date(at.getTime() + 60_000), at, new SessionPolicy(60_000, 1000, 600_000))
            await repository.Insert(scoped('a1', 'alice', ['acme']))
            await repository.Insert(scoped('a2', 'alice', ['other', 'acme']))
            await repository.Insert(scoped('a3', 'alice', ['other']))
            await repository.Insert(C.Record('a4', 'alice'))
            await repository.Insert(scoped('b1', 'bob', ['acme']))
            assert.equal(await repository.DeleteSubjectWithClaim('alice', 'tenant', 'acme'), 2)
            assert.equal(await repository.Find('a1'), null)
            assert.equal(await repository.Find('a2'), null)
            for (const kept of ['a3', 'a4', 'b1'])
            {
                assert.notEqual(await repository.Find(kept), null, kept)
            }
            assert.equal(await repository.DeleteSubjectWithClaim('alice', 'tenant', 'acme'), 0)
        })

        test(`${label}: ReplaceSubject ends the subject's sessions and stores the fresh one`, async () =>
        {
            const repository = await open()
            await repository.Insert(C.Record('a1', 'alice'))
            await repository.Insert(C.Record('b1', 'bob'))
            const fresh = C.Record('a9', 'alice')
            assert.equal(await repository.ReplaceSubject('alice', fresh), 1)
            assert.equal(await repository.Find('a1'), null)
            assert.deepEqual(await repository.Find('a9'), fresh)
            assert.notEqual(await repository.Find('b1'), null)
        })

        test(`${label}: Extend moves the expiry and the kept time`, async () =>
        {
            const repository = await open()
            await repository.Insert(C.Record('id-1', 'alice'))
            const expires = new Date('2026-11-21T00:00:00.000Z')
            const kept = new Date('2026-11-20T11:00:00.000Z')
            assert.equal(await repository.Extend('id-1', expires, kept), true)
            const found = await repository.Find('id-1')
            assert.deepEqual([found?.ExpiresAt, found?.KeptAt], [expires, kept])
            assert.equal(await repository.Extend('nope', expires, kept), false)
        })

        test(`${label}: DeleteExpired drops sessions whose expiry is at or before now`, async () =>
        {
            const repository = await open()
            await repository.Insert(C.Record('short', 'alice', 1000))
            await repository.Insert(C.Record('long', 'alice', 60_000))
            assert.equal(await repository.DeleteExpired(new Date(C.At.getTime() + 1000)), 1)
            assert.equal(await repository.Find('short'), null)
            assert.notEqual(await repository.Find('long'), null)
        })
    }
}
