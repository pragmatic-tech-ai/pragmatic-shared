import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IdentityConfig, DelegationDepth, Role, InvalidSecurityModelError } from '@pragmatic-tech-ai/pragmatic-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlRealmConfigStore } from '../sql-realm-config-store.js'

SqlTestSessions.Describe('SqlRealmConfigStore', (makeSession, backend) =>
{
    const config = () => new IdentityConfig('pack-1', DelegationDepth.FullAuthz, new Map([['s', 'v']]), new Map([['grp', Role.Editor]]), new Map([['email', 'email']]))

    test(`${backend}: Save then Get round-trips all map fields; Get missing is null`, async () =>
    {
        const tid = `cfg-${randomUUID()}`
        const store = await SqlRealmConfigStore.Open(await makeSession())
        assert.equal(await store.Get(tid), null)
        await store.Save(tid, config())
        const got = (await store.Get(tid))!
        assert.equal(got.PackId, 'pack-1')
        assert.equal(got.DelegationDepth, DelegationDepth.FullAuthz)
        assert.equal(got.ProviderSettings.get('s'), 'v')
        assert.equal(got.GroupRoleMap.get('grp'), Role.Editor)
        assert.equal(got.ClaimsMapping.get('email'), 'email')
    })

    test(`${backend}: Save upserts and List returns saved realm ids`, async () =>
    {
        const tid = `cfg-${randomUUID()}`
        const store = await SqlRealmConfigStore.Open(await makeSession())
        await store.Save(tid, config())
        await store.Save(tid, new IdentityConfig('pack-2', DelegationDepth.AuthnDirectory, new Map(), new Map(), new Map()))
        const got = (await store.Get(tid))!
        assert.equal(got.PackId, 'pack-2')
        assert.equal(got.DelegationDepth, DelegationDepth.AuthnDirectory)
        assert.equal(got.ProviderSettings.size, 0)
        assert.equal(got.GroupRoleMap.size, 0)
        assert.equal(got.ClaimsMapping.size, 0)
        assert.ok((await store.List()).includes(tid))
    })

    test(`${backend}: the security model round-trips through Save/Get and a reopen; Save without one clears it`, async () =>
    {
        const tid = `cfg-${randomUUID()}`
        const session = await makeSession()
        const model: ISecurityModelConfig = {
            businessUnits: [{ id: 'root', name: 'Root' }, { id: 'eng', name: 'Eng', parent: 'root' }],
            users: [{ principalId: 'u1', businessUnitId: 'eng' }],
            teams: [{ id: 't-web', name: 'Web', businessUnitId: 'eng', idpGroups: ['web'], manualMembers: ['u1'] }],
            roleAssignments: [{ role: 'Reader', principalIds: ['u1'], teamIds: ['t-web'] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: [],
        }
        await (await SqlRealmConfigStore.Open(session)).Save(tid, new IdentityConfig('p', DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), model))
        const reopened = await SqlRealmConfigStore.Open(session)
        assert.deepEqual((await reopened.Get(tid))!.SecurityModel, model)
        await reopened.Save(tid, config())
        assert.equal((await reopened.Get(tid))!.SecurityModel, undefined)
    })

    test(`${backend}: an invalid security model is refused on Save and a stored one fails closed on Get`, async () =>
    {
        const tid = `cfg-${randomUUID()}`
        const session = await makeSession()
        const store = await SqlRealmConfigStore.Open(session)
        const invalid = { businessUnits: [{ id: 'eng', name: 'Eng', parent: 'missing' }], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] } as ISecurityModelConfig
        await assert.rejects(store.Save(tid, new IdentityConfig('p', DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), invalid)), InvalidSecurityModelError)
        await store.Save(tid, config())
        await session.Execute('UPDATE identity_realm_config SET security_model = $1 WHERE realm_id = $2', [JSON.stringify(invalid), tid])
        await assert.rejects(store.Get(tid), InvalidSecurityModelError)
    })
})
