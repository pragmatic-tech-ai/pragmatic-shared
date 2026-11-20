import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LocalAccountNotFoundError, LocalGroupNotFoundError, SystemPrincipal, Principal, PrincipalKind, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlLocalAccountStore } from '../sql-local-account-store.js'

SqlTestSessions.Describe('SqlLocalAccountStore', (makeSession, backend) =>
{
    test(`${backend}: CreateAccount then find by email and principal`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        const created = await store.CreateAccount(realm, 'a@x.io', 'p1', 'ref1')
        assert.equal(created.PrincipalId, 'p1')
        assert.equal((await store.FindByEmail(realm, 'a@x.io'))!.PrincipalId, 'p1')
        assert.equal((await store.FindByPrincipalId(realm, 'p1'))!.Email, 'a@x.io')
        assert.equal((await store.Lookup('p1', realm))!.Id, 'p1')
        assert.equal(await store.FindByEmail(realm, 'missing@x.io'), null)
    })

    test(`${backend}: duplicate email and duplicate principal are rejected`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await store.CreateAccount(realm, 'dup@x.io', 'pa', 'r')
        await assert.rejects(() => store.CreateAccount(realm, 'dup@x.io', 'pb', 'r'), /email already registered/)
        await assert.rejects(() => store.CreateAccount(realm, 'other@x.io', 'pa', 'r'), /principal already registered/)
    })

    test(`${backend}: the same email in a different realm is allowed`, async () =>
    {
        const t1 = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const t2 = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T2')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await store.CreateAccount(t1, 'shared@x.io', 'p1', 'r')
        const created = await store.CreateAccount(t2, 'shared@x.io', 'p1', 'r')
        assert.equal(created.RealmId, t2.Id)
        const found1 = await store.FindByEmail(t1, 'shared@x.io')
        const found2 = await store.FindByEmail(t2, 'shared@x.io')
        assert.notEqual(found1, null)
        assert.notEqual(found2, null)
        assert.equal(found1!.RealmId, t1.Id)
        assert.equal(found2!.RealmId, t2.Id)
    })

    test(`${backend}: GroupsOf returns already-populated groups without the DB`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        const principal = new Principal('p1', realm.Id, PrincipalKind.User, new Map(), ['g1'])
        assert.deepEqual(await store.GroupsOf(principal), ['g1'])
    })

    test(`${backend}: GroupsOf falls back to the DB when groups are empty`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const session = await makeSession()
        const store = await SqlLocalAccountStore.Open(session)
        await store.CreateAccount(realm, 'g@x.io', 'p1', 'r')
        await store.CreateGroup(realm, 'g2', 'G2')
        await store.AddMember(realm, 'g2', 'p1')
        const principal = new Principal('p1', realm.Id, PrincipalKind.User, new Map(), [])
        assert.deepEqual(await store.GroupsOf(principal), ['g2'])
    })

    test(`${backend}: GroupsOf for an unknown principal is empty and Lookup is null`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        const principal = new Principal('ghost', realm.Id, PrincipalKind.User, new Map(), [])
        assert.deepEqual(await store.GroupsOf(principal), [])
        assert.equal(await store.Lookup('ghost', realm), null)
    })

    test(`${backend}: Disable hides the account from Lookup but keeps it listed`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await store.CreateAccount(realm, 'd@x.io', 'p1', 'r')
        assert.equal((await store.FindByPrincipalId(realm, 'p1'))!.Disabled, false)
        await store.Disable(realm, 'p1')
        assert.equal(await store.Lookup('p1', realm), null)
        assert.equal((await store.FindByPrincipalId(realm, 'p1'))!.Disabled, true)
        const listed = await store.ListAccounts(realm)
        assert.equal(listed.length, 1)
        assert.equal(listed[0]!.Disabled, true)
    })

    test(`${backend}: Disable of an unknown principal throws LocalAccountNotFoundError`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await assert.rejects(() => store.Disable(realm, 'ghost'), LocalAccountNotFoundError)
    })

    test(`${backend}: ListAccounts is realm-isolated`, async () =>
    {
        const t1 = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const t2 = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T2')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await store.CreateAccount(t1, 'a@x.io', 'p1', 'r')
        await store.CreateAccount(t1, 'b@x.io', 'p2', 'r')
        await store.CreateAccount(t2, 'c@x.io', 'p3', 'r')
        assert.deepEqual((await store.ListAccounts(t1)).map(a => a.PrincipalId).sort(), ['p1', 'p2'])
        assert.deepEqual((await store.ListAccounts(t2)).map(a => a.PrincipalId), ['p3'])
        await assert.rejects(() => store.Disable(t2, 'p1'), LocalAccountNotFoundError)
    })

    test(`${backend}: Enable re-enables a disabled account and rejects an unknown principal`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await store.CreateAccount(realm, 'e@x.io', 'p1', 'r')
        await store.Disable(realm, 'p1')
        assert.equal(await store.Lookup('p1', realm), null)
        assert.equal((await store.FindByPrincipalId(realm, 'p1'))!.Disabled, true)
        await store.Enable(realm, 'p1')
        assert.equal((await store.FindByPrincipalId(realm, 'p1'))!.Disabled, false)
        assert.equal((await store.Lookup('p1', realm))!.Id, 'p1')
        await assert.rejects(() => store.Enable(realm, 'nobody'), LocalAccountNotFoundError)
    })

    test(`${backend}: local groups round-trip, survive reopen, feed Lookup and stay realm-isolated`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const other = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T2')
        const session = await makeSession()
        const store = await SqlLocalAccountStore.Open(session)
        await store.CreateAccount(realm, 'dana@x.io', 'dana', 'ref')
        const created = await store.CreateGroup(realm, 'hr-staff', 'HR staff')
        assert.deepEqual(created.MemberIds, [])
        await store.AddMember(realm, 'hr-staff', 'dana')
        await store.AddMember(realm, 'hr-staff', 'dana')
        await store.AddMember(realm, 'hr-staff', 'sam')
        await assert.rejects(() => store.AddMember(realm, 'missing', 'dana'), LocalGroupNotFoundError)
        await assert.rejects(() => store.RemoveMember(realm, 'missing', 'dana'), LocalGroupNotFoundError)
        await assert.rejects(() => store.DeleteGroup(realm, 'missing'), LocalGroupNotFoundError)
        await assert.rejects(() => store.CreateGroup(realm, 'hr-staff', 'again'), /group already exists/)
        await store.CreateGroup(other, 'hr-staff', 'Other HR')
        await assert.rejects(() => store.AddMember(other, 'missing', 'dana'), LocalGroupNotFoundError)

        const reopened = await SqlLocalAccountStore.Open(session)
        assert.deepEqual((await reopened.Lookup('dana', realm))?.Groups, ['hr-staff'])
        const groups = await reopened.ListGroups(realm)
        assert.deepEqual(groups.map(g => [g.GroupId, g.RealmId, g.Name, g.MemberIds]), [['hr-staff', realm.Id, 'HR staff', ['dana', 'sam']]])
        assert.deepEqual((await reopened.ListGroups(other)).map(g => [g.Name, g.MemberIds]), [['Other HR', []]])
        await reopened.RemoveMember(realm, 'hr-staff', 'dana')
        assert.deepEqual((await reopened.Lookup('dana', realm))?.Groups, [])
        await reopened.DeleteGroup(realm, 'hr-staff')
        assert.deepEqual(await reopened.ListGroups(realm), [])
        assert.equal((await reopened.ListGroups(other)).length, 1)
    })

    test(`${backend}: reserved system principal ids are refused`, async () =>
    {
        const realm = new Realm(`acct-${randomUUID()}`, RealmKind.SelfHosted, 'T1')
        const store = await SqlLocalAccountStore.Open(await makeSession())
        await assert.rejects(() => store.CreateAccount(realm, 's@x.io', SystemPrincipal.IdFor('env1'), 'r'), /reserved system prefix/)
    })
})
