import { test } from "node:test";
import assert from "node:assert/strict";
import { ApplicationDeclaration, ApplicationRoleDeclaration, InvalidRealmRoleError, RealmRole, RoleMapping, RoleMember } from "@pragmatic-tech-ai/pragmatic-identity";
import { DuplicateTenantRoleError, TenantRoleDeclaration, TenantRoleRegistry } from "../tenant-role-registry.js";
import { InMemoryRoleMappingStore } from "../in-memory-role-mapping-store.js";
import { InMemoryApplicationCatalogue } from "../in-memory-application-catalogue.js";
import { RoleMappingError, RoleMappingErrorReason, RoleMappingService } from "../role-mapping-service.js";
import { RealmRoleResolver, RealmRoleScope, SignInFacts } from "../realm-role-resolver.js";

class Fixture
{
    public static readonly Realm = "acme-001";
    public static readonly Google = "google";
    public static readonly Entra = "entra";

    public static Ledger(...roles: string[]): ApplicationDeclaration
    {
        return new ApplicationDeclaration("ledger", roles.map(role => new ApplicationRoleDeclaration(role, role)));
    }

    public static Map(role: string, member: RoleMember): RoleMapping
    {
        return new RoleMapping(RealmRole.Parse(role), member);
    }

    public static async Make(tenantRoles: TenantRoleRegistry = TenantRoleRegistry.Standard): Promise<{ Catalogue: InMemoryApplicationCatalogue, Store: InMemoryRoleMappingStore, Service: RoleMappingService, Resolver: RealmRoleResolver }>
    {
        const catalogue = new InMemoryApplicationCatalogue();
        await catalogue.Declare(Fixture.Realm, Fixture.Ledger("finance", "sales"));
        const store = new InMemoryRoleMappingStore();
        return { Catalogue: catalogue, Store: store, Service: new RoleMappingService(tenantRoles, catalogue, store), Resolver: new RealmRoleResolver(tenantRoles, catalogue, store) };
    }

    public static Scope(): RealmRoleScope
    {
        return new RealmRoleScope(Fixture.Realm, [Fixture.Google, Fixture.Entra]);
    }
}

test("the standard tenant roles are admin only; a registry is data and refuses bad or duplicate names", () =>
{
    assert.deepEqual(TenantRoleRegistry.Standard.Roles.map(role => role.Name), ["admin"]);
    assert.ok(TenantRoleRegistry.Standard.Has(TenantRoleRegistry.Admin));
    const wider = new TenantRoleRegistry([new TenantRoleDeclaration("support", ""), new TenantRoleDeclaration("admin", "")]);
    assert.deepEqual(wider.Roles.map(role => role.Name), ["admin", "support"]);
    assert.throws(() => new TenantRoleRegistry([new TenantRoleDeclaration("a:b", "")]), InvalidRealmRoleError);
    assert.throws(() => new TenantRoleRegistry([new TenantRoleDeclaration("admin", ""), new TenantRoleDeclaration("admin", "")]), DuplicateTenantRoleError);
});

test("the in-memory stores keep mappings as a set and applications by name, per realm", async () =>
{
    const store = new InMemoryRoleMappingStore();
    const mapping = Fixture.Map("admin", RoleMember.Group(Fixture.Google, "ops"));
    assert.equal(await store.Add(Fixture.Realm, mapping), true);
    assert.equal(await store.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Group(Fixture.Google, "ops"))), false);
    assert.equal((await store.MappingsFor(Fixture.Realm)).length, 1);
    assert.equal((await store.MappingsFor("other")).length, 0);
    assert.equal(await store.Remove("other", mapping), false);
    assert.equal(await store.Remove(Fixture.Realm, mapping), true);
    assert.equal(await store.Remove(Fixture.Realm, mapping), false);

    const catalogue = new InMemoryApplicationCatalogue();
    await catalogue.Declare(Fixture.Realm, Fixture.Ledger("sales"));
    await catalogue.Declare(Fixture.Realm, new ApplicationDeclaration("crm", []));
    await catalogue.Declare(Fixture.Realm, Fixture.Ledger("finance"));
    assert.deepEqual((await catalogue.Applications(Fixture.Realm)).map(a => a.Name), ["crm", "ledger"]);
    assert.ok((await catalogue.Application(Fixture.Realm, "ledger"))?.Declares("finance"));
    assert.equal(await catalogue.Application("other", "ledger"), null);
    assert.equal(await catalogue.Remove(Fixture.Realm, "crm"), true);
    assert.equal(await catalogue.Remove(Fixture.Realm, "crm"), false);
});

test("the mapping service offers the tenant roles and the declared application roles", async () =>
{
    const { Service: service } = await Fixture.Make();
    assert.deepEqual((await service.AssignableRoles(Fixture.Realm)).map(r => r.Role.ToString()), ["admin", "ledger:finance", "ledger:sales"]);
    assert.deepEqual((await service.AssignableRoles("other")).map(r => r.Role.ToString()), ["admin"]);
});

test("the mapping service validates: unknown tenant role, unknown application, undeclared role, bad member", async () =>
{
    const { Service: service } = await Fixture.Make();
    const cases: [RoleMapping, RoleMappingErrorReason][] = [
        [Fixture.Map("support", RoleMember.Group(Fixture.Google, "x")), RoleMappingErrorReason.UnknownTenantRole],
        [Fixture.Map("crm:viewer", RoleMember.Group(Fixture.Google, "x")), RoleMappingErrorReason.UnknownApplication],
        [Fixture.Map("ledger:audit", RoleMember.Group(Fixture.Google, "x")), RoleMappingErrorReason.UndeclaredApplicationRole],
        [Fixture.Map("admin", RoleMember.Group("", "x")), RoleMappingErrorReason.InvalidMember],
        [Fixture.Map("admin", RoleMember.Account("")), RoleMappingErrorReason.InvalidMember],
    ];
    for (const [mapping, reason] of cases)
    {
        await assert.rejects(service.Add(Fixture.Realm, mapping), (err: Error) => err instanceof RoleMappingError && err.Reason === reason, reason);
    }
    assert.equal((await service.List(Fixture.Realm)).length, 0);
});

test("the mapping service adds, lists in order and removes mappings", async () =>
{
    const { Service: service } = await Fixture.Make();
    assert.equal(await service.Add(Fixture.Realm, Fixture.Map("ledger:sales", RoleMember.User(Fixture.Entra, "sub-9"))), true);
    assert.equal(await service.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Account("acc-1"))), true);
    assert.equal(await service.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Account("acc-1"))), false);
    assert.deepEqual((await service.List(Fixture.Realm)).map(m => m.Role.ToString()), ["admin", "ledger:sales"]);
    assert.equal(await service.Remove(Fixture.Realm, Fixture.Map("admin", RoleMember.Account("acc-1"))), true);
    assert.deepEqual((await service.List(Fixture.Realm)).map(m => m.Role.ToString()), ["ledger:sales"]);
});

test("resolution: groups of the same source, users by source and subject, accounts by id", async () =>
{
    const { Service: service, Resolver: resolver } = await Fixture.Make();
    await service.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Group(Fixture.Google, "ops")));
    await service.Add(Fixture.Realm, Fixture.Map("ledger:finance", RoleMember.Group(Fixture.Entra, "finance")));
    await service.Add(Fixture.Realm, Fixture.Map("ledger:sales", RoleMember.User(Fixture.Entra, "sub-9")));
    await service.Add(Fixture.Realm, Fixture.Map("ledger:sales", RoleMember.Account("acc-7")));

    const viaGoogle = await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-1", Fixture.Google, "g-1", ["ops", "finance"]));
    assert.deepEqual(viaGoogle.ToPayload(), { roles: ["admin"], app_roles: {} });

    const viaEntra = await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-2", Fixture.Entra, "sub-9", ["finance", "ops"]));
    assert.deepEqual(viaEntra.ToPayload(), { roles: [], app_roles: { ledger: ["finance", "sales"] } });

    const byAccount = await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-7", Fixture.Google, "g-7", []));
    assert.deepEqual(byAccount.ToPayload(), { roles: [], app_roles: { ledger: ["sales"] } });

    const nobody = await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-3", Fixture.Google, "g-3", ["OPS", "staff"]));
    assert.ok(nobody.IsEmpty);
});

test("resolution grants nothing from an unknown or empty source, not even by account", async () =>
{
    const { Service: service, Resolver: resolver } = await Fixture.Make();
    await service.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Account("acc-1")));
    await service.Add(Fixture.Realm, Fixture.Map("admin", RoleMember.Group("github", "ops")));
    assert.ok((await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-1", "github", "x", ["ops"]))).IsEmpty);
    assert.ok((await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-1", "", "x", []))).IsEmpty);
    assert.deepEqual((await resolver.Resolve(Fixture.Scope(), new SignInFacts("acc-1", Fixture.Google, "x", []))).TenantRoles, ["admin"]);
});

test("stale mappings grant nothing: a removed application, a dropped application role, a retired tenant role", async () =>
{
    const wider = new TenantRoleRegistry([new TenantRoleDeclaration("admin", ""), new TenantRoleDeclaration("support", "")]);
    const { Catalogue: catalogue, Store: store, Service: service } = await Fixture.Make(wider);
    await service.Add(Fixture.Realm, Fixture.Map("support", RoleMember.Group(Fixture.Google, "ops")));
    await service.Add(Fixture.Realm, Fixture.Map("ledger:finance", RoleMember.Group(Fixture.Google, "ops")));
    await service.Add(Fixture.Realm, Fixture.Map("ledger:sales", RoleMember.Group(Fixture.Google, "ops")));
    const signIn = new SignInFacts("acc-1", Fixture.Google, "g", ["ops"]);

    assert.deepEqual((await new RealmRoleResolver(wider, catalogue, store).Resolve(Fixture.Scope(), signIn)).Qualified(), ["support", "ledger:finance", "ledger:sales"]);
    await catalogue.Declare(Fixture.Realm, Fixture.Ledger("sales"));
    const narrowed = new RealmRoleResolver(TenantRoleRegistry.Standard, catalogue, store);
    assert.deepEqual((await narrowed.Resolve(Fixture.Scope(), signIn)).Qualified(), ["ledger:sales"]);
    await catalogue.Remove(Fixture.Realm, "ledger");
    assert.ok((await narrowed.Resolve(Fixture.Scope(), signIn)).IsEmpty);
});

test("resolution is deterministic: independent of mapping and group order", async () =>
{
    const first = await Fixture.Make();
    const second = await Fixture.Make();
    const mappings = [
        Fixture.Map("ledger:sales", RoleMember.Group(Fixture.Google, "b")),
        Fixture.Map("admin", RoleMember.Group(Fixture.Google, "a")),
        Fixture.Map("ledger:finance", RoleMember.Group(Fixture.Google, "a")),
    ];
    for (const mapping of mappings)
    {
        await first.Service.Add(Fixture.Realm, mapping);
    }
    for (const mapping of [...mappings].reverse())
    {
        await second.Service.Add(Fixture.Realm, mapping);
    }
    const one = await first.Resolver.Resolve(Fixture.Scope(), new SignInFacts("x", Fixture.Google, "s", ["a", "b", "a"]));
    const two = await second.Resolver.Resolve(Fixture.Scope(), new SignInFacts("x", Fixture.Google, "s", ["b", "a"]));
    assert.deepEqual(JSON.stringify(one.ToPayload()), JSON.stringify(two.ToPayload()));
    assert.deepEqual(one.ToPayload(), { roles: ["admin"], app_roles: { ledger: ["finance", "sales"] } });
});
