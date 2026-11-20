import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ApplicationDeclaration, ApplicationRoleDeclaration, RealmRole, RoleMapping, RoleMember } from '@pragmatic-tech-ai/pragmatic-identity'
import { RealmRoleResolver, RealmRoleScope, RoleMappingService, SignInFacts, TenantRoleRegistry } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlRoleMappingStore } from '../sql-role-mapping-store.js'
import { SqlApplicationCatalogue } from '../sql-application-catalogue.js'

class Fixture
{
    public static Realm(): string
    {
        return `realm-${randomUUID()}`
    }

    public static Map(role: string, member: RoleMember): RoleMapping
    {
        return new RoleMapping(RealmRole.Parse(role), member)
    }

    public static Ledger(...roles: string[]): ApplicationDeclaration
    {
        return new ApplicationDeclaration('ledger', roles.map(role => new ApplicationRoleDeclaration(role, `the ${role} role`)))
    }
}

SqlTestSessions.Describe('SqlRoleMappingStore', (makeSession, backend) =>
{
    test(`${backend}: mappings are a per-realm set, listed in order, and round-trip every member kind`, async () =>
    {
        const realm = Fixture.Realm()
        const store = await SqlRoleMappingStore.Open(await makeSession())
        const mappings = [
            Fixture.Map('ledger:sales', RoleMember.User('entra', 'sub-9')),
            Fixture.Map('admin', RoleMember.Group('google', 'ops')),
            Fixture.Map('admin', RoleMember.Account('acc-1')),
        ]
        for (const mapping of mappings)
        {
            assert.equal(await store.Add(realm, mapping), true)
        }
        assert.equal(await store.Add(realm, Fixture.Map('admin', RoleMember.Group('google', 'ops'))), false)
        const listed = await store.MappingsFor(realm)
        assert.deepEqual(listed.map(m => m.Key()), RoleMapping.Sorted(mappings).map(m => m.Key()))
        assert.equal((await store.MappingsFor(Fixture.Realm())).length, 0)
        assert.equal(await store.Remove(realm, Fixture.Map('admin', RoleMember.Account('acc-1'))), true)
        assert.equal(await store.Remove(realm, Fixture.Map('admin', RoleMember.Account('acc-1'))), false)
        assert.equal((await store.MappingsFor(realm)).length, 2)
    })

    test(`${backend}: a row whose role or member no longer parses is skipped`, async () =>
    {
        const realm = Fixture.Realm()
        const session = await makeSession()
        const store = await SqlRoleMappingStore.Open(session)
        await store.Add(realm, Fixture.Map('admin', RoleMember.Group('google', 'ops')))
        await session.Execute('INSERT INTO identity_role_mappings (realm_id, role, member_kind, member_source, member_value) VALUES ($1, $2, $3, $4, $5)', [realm, 'Not A Role', 'source-group', 'google', 'ops'])
        await session.Execute('INSERT INTO identity_role_mappings (realm_id, role, member_kind, member_source, member_value) VALUES ($1, $2, $3, $4, $5)', [realm, 'admin', 'everyone', 'google', 'ops'])
        assert.deepEqual((await store.MappingsFor(realm)).map(m => m.Role.ToString()), ['admin'])
    })
})

SqlTestSessions.Describe('SqlApplicationCatalogue', (makeSession, backend) =>
{
    test(`${backend}: Declare upserts by application; Applications lists by name; Remove reports whether it was known`, async () =>
    {
        const realm = Fixture.Realm()
        const catalogue = await SqlApplicationCatalogue.Open(await makeSession())
        await catalogue.Declare(realm, Fixture.Ledger('sales'))
        await catalogue.Declare(realm, new ApplicationDeclaration('crm', []))
        await catalogue.Declare(realm, Fixture.Ledger('finance', 'sales'))
        const applications = await catalogue.Applications(realm)
        assert.deepEqual(applications.map(a => a.Name), ['crm', 'ledger'])
        const ledger = await catalogue.Application(realm, 'ledger')
        assert.deepEqual(ledger?.Roles.map(r => [r.Name, r.Description]), [['finance', 'the finance role'], ['sales', 'the sales role']])
        assert.equal(await catalogue.Application(Fixture.Realm(), 'ledger'), null)
        assert.equal(await catalogue.Remove(realm, 'crm'), true)
        assert.equal(await catalogue.Remove(realm, 'crm'), false)
    })

    test(`${backend}: the service and the resolver run over the SQL stores`, async () =>
    {
        const realm = Fixture.Realm()
        const session = await makeSession()
        const catalogue = await SqlApplicationCatalogue.Open(session)
        const store = await SqlRoleMappingStore.Open(session)
        await catalogue.Declare(realm, Fixture.Ledger('finance'))
        const service = new RoleMappingService(TenantRoleRegistry.Standard, catalogue, store)
        await service.Add(realm, Fixture.Map('admin', RoleMember.Group('google', 'ops')))
        await service.Add(realm, Fixture.Map('ledger:finance', RoleMember.Group('google', 'ops')))
        await assert.rejects(service.Add(realm, Fixture.Map('ledger:sales', RoleMember.Group('google', 'ops'))))
        const claims = await new RealmRoleResolver(TenantRoleRegistry.Standard, catalogue, store).Resolve(new RealmRoleScope(realm, ['google']), new SignInFacts('acc', 'google', 'sub', ['ops']))
        assert.deepEqual(claims.ToPayload(), { roles: ['admin'], app_roles: { ledger: ['finance'] } })
    })
})
