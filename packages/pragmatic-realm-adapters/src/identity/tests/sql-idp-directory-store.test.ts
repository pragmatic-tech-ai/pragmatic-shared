import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IdpDirectorySnapshot, IdpUserState, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlIdpDirectoryStore } from '../sql-idp-directory-store.js'

SqlTestSessions.Describe('SqlIdpDirectoryStore', (makeSession, backend) =>
{
    test(`${backend}: round-trips states and members per realm, survives reopen, unknown realm is null`, async () =>
    {
        const t1 = `dir-${randomUUID()}`
        const t2 = `dir-${randomUUID()}`
        const session = await makeSession()
        const store = await SqlIdpDirectoryStore.Open(session)
        const at = new Date('2026-11-11T10:00:00Z')
        await store.Save(t1, new IdpDirectorySnapshot(at, true, new Map([['dana', IdpUserState.Disabled]]), new Map([['hr', ['dana', 'sam']]])))
        await store.Save(t2, new IdpDirectorySnapshot(at, false, new Map([['x', IdpUserState.Enabled]]), new Map()))

        const reopened = await SqlIdpDirectoryStore.Open(session)
        const one = await reopened.Get(t1)
        assert.equal(one?.TakenAt.toISOString(), at.toISOString())
        assert.equal(one?.Authoritative, true)
        assert.equal(one?.StateOf('dana'), IdpUserState.Disabled)
        assert.deepEqual(one?.MembersOf('hr'), ['dana', 'sam'])
        assert.equal((await reopened.Get(t2))?.StateOf('dana'), IdpUserState.Unknown)
        assert.equal((await reopened.Get(t2))?.Authoritative, false)
        assert.equal(await reopened.Get(`dir-${randomUUID()}`), null)

        const later = new Date('2026-11-12T10:00:00Z')
        await reopened.Save(t1, new IdpDirectorySnapshot(later, true, new Map([['dana', IdpUserState.Enabled]]), new Map()))
        const replaced = await (await SqlIdpDirectoryStore.Open(session)).Get(t1)
        assert.equal(replaced?.TakenAt.toISOString(), later.toISOString())
        assert.equal(replaced?.StateOf('dana'), IdpUserState.Enabled)
        assert.deepEqual(replaced?.MembersOf('hr'), [])
    })

    test(`${backend}: an unreadable stored record fails closed until the next Save replaces it`, async () =>
    {
        const realm = `dir-${randomUUID()}`
        const session = await makeSession()
        const store = await SqlIdpDirectoryStore.Open(session)
        const at = new Date('2026-11-11T10:00:00Z')
        await store.Save(realm, new IdpDirectorySnapshot(at, true, new Map([['dana', IdpUserState.Enabled]]), new Map()))
        await session.Execute('UPDATE identity_idp_directory SET users = $1 WHERE realm_id = $2', [JSON.stringify([['dana', 'bogus']]), realm])
        await assert.rejects(() => store.Get(realm), UnreadableIdpDirectoryRecordError)
        await session.Execute('UPDATE identity_idp_directory SET users = $1 WHERE realm_id = $2', ['not json', realm])
        await assert.rejects(() => store.Get(realm), UnreadableIdpDirectoryRecordError)
        await session.Execute('UPDATE identity_idp_directory SET users = $1, taken_at = $2 WHERE realm_id = $3', ['[]', 'not a date', realm])
        await assert.rejects(() => store.Get(realm), UnreadableIdpDirectoryRecordError)
        await store.Save(realm, new IdpDirectorySnapshot(at, true, new Map([['dana', IdpUserState.Deleted]]), new Map()))
        assert.equal((await store.Get(realm))?.StateOf('dana'), IdpUserState.Deleted)
    })
})
