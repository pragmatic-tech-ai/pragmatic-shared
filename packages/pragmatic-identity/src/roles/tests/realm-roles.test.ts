import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidRealmRoleError, RealmRole, RealmRoleKind } from "../realm-role.js";
import { RoleMember, RoleMemberKind } from "../role-member.js";
import { RoleMapping } from "../role-mapping.js";
import { ApplicationDeclaration, ApplicationRoleDeclaration } from "../application-declaration.js";
import { RealmRoleClaims } from "../realm-role-claims.js";

test("a realm role parses as a tenant role or an application role and prints back", () =>
{
    const admin = RealmRole.Parse("admin");
    assert.equal(admin.Kind, RealmRoleKind.Tenant);
    assert.equal(admin.ToString(), "admin");
    const finance = RealmRole.Parse("ledger:finance");
    assert.equal(finance.Kind, RealmRoleKind.Application);
    assert.equal(finance.Application, "ledger");
    assert.equal(finance.Name, "finance");
    assert.equal(finance.ToString(), "ledger:finance");
    assert.ok(finance.Equals(RealmRole.OfApplication("ledger", "finance")));
    assert.ok(!finance.Equals(RealmRole.Tenant("finance")));
});

test("malformed realm roles are refused", () =>
{
    for (const text of ["", "Admin", ":x", "ledger:", "Ledger:x", "a:b:c", "led ger:x", "admin "])
    {
        assert.equal(RealmRole.TryParse(text), null, text);
        assert.throws(() => RealmRole.Parse(text), InvalidRealmRoleError, text);
    }
    assert.throws(() => RealmRole.Tenant("a:b"), InvalidRealmRoleError);
    assert.throws(() => RealmRole.OfApplication("ledger", ""), InvalidRealmRoleError);
});

test("role members: groups and users name a source, accounts do not; From restores stored parts", () =>
{
    assert.ok(RoleMember.Group("google", "staff").IsWellFormed);
    assert.ok(RoleMember.User("entra", "sub-1").IsWellFormed);
    assert.ok(RoleMember.Account("acc-1").IsWellFormed);
    assert.ok(!RoleMember.Group("", "staff").IsWellFormed);
    assert.ok(!RoleMember.User("entra", "").IsWellFormed);
    assert.ok(!RoleMember.Account("").IsWellFormed);
    assert.ok(RoleMember.From(RoleMemberKind.SourceGroup, "google", "staff")?.Equals(RoleMember.Group("google", "staff")));
    assert.equal(RoleMember.From("nope", "google", "staff"), null);
    assert.equal(RoleMember.From(RoleMemberKind.Account, "google", "acc"), null);
    assert.ok(!RoleMember.Group("s", "x").Equals(RoleMember.User("s", "x")));
});

test("role mappings sort deterministically by role, then member", () =>
{
    const a = new RoleMapping(RealmRole.Parse("admin"), RoleMember.Group("google", "ops"));
    const b = new RoleMapping(RealmRole.Parse("admin"), RoleMember.Account("acc"));
    const c = new RoleMapping(RealmRole.Parse("ledger:finance"), RoleMember.Group("google", "finance"));
    const sorted = RoleMapping.Sorted([c, a, b]);
    assert.deepEqual(sorted.map(m => m.Key()), RoleMapping.Sorted([b, c, a]).map(m => m.Key()));
    assert.ok(sorted[0]!.Role.IsTenantRole && sorted[1]!.Role.IsTenantRole);
    assert.ok(a.Equals(new RoleMapping(RealmRole.Tenant("admin"), RoleMember.Group("google", "ops"))));
});

test("an application declaration reads a descriptor's name and roles", () =>
{
    const declaration = ApplicationDeclaration.FromDescriptor({ Name: "ledger", Roles: [{ Name: "sales", Description: "Sales" }, { Name: "finance", Description: "Finance" }] });
    assert.equal(declaration.Name, "ledger");
    assert.deepEqual(declaration.Roles.map(r => r.Name), ["finance", "sales"]);
    assert.ok(declaration.Declares("sales"));
    assert.ok(!declaration.Declares("admin"));
    assert.ok(new ApplicationDeclaration("x", [new ApplicationRoleDeclaration("r", "")]).Declares("r"));
});

test("role claims: both claims always present, sorted and unique, empty applications left out", () =>
{
    const claims = new RealmRoleClaims(["admin", "admin"], new Map([["ledger", ["sales", "finance", "sales"]], ["empty", []]]));
    assert.deepEqual(claims.ToPayload(), { roles: ["admin"], app_roles: { ledger: ["finance", "sales"] } });
    assert.deepEqual(RealmRoleClaims.Empty.ToPayload(), { roles: [], app_roles: {} });
    assert.ok(RealmRoleClaims.Empty.IsEmpty);
    assert.deepEqual(claims.Qualified(), ["admin", "ledger:finance", "ledger:sales"]);
    assert.deepEqual(claims.RolesOf("ledger"), ["finance", "sales"]);
    assert.deepEqual(claims.RolesOf("crm"), []);
});

test("role claims round-trip through the payload and the qualified form; malformed entries are dropped", () =>
{
    const claims = RealmRoleClaims.FromRoles([RealmRole.Parse("ledger:sales"), RealmRole.Parse("admin"), RealmRole.Parse("crm:viewer")]);
    assert.deepEqual(RealmRoleClaims.FromPayload(claims.ToPayload()).ToPayload(), claims.ToPayload());
    assert.deepEqual(RealmRoleClaims.FromQualified(claims.Qualified()).ToPayload(), claims.ToPayload());
    const read = RealmRoleClaims.FromPayload({ roles: ["admin", 7, "Bad Role", "x:y"], app_roles: { ledger: ["sales", 1, "no way"], "Bad App": ["x"] } });
    assert.deepEqual(read.ToPayload(), { roles: ["admin"], app_roles: { ledger: ["sales"] } });
    assert.deepEqual(RealmRoleClaims.FromPayload({ roles: "admin", app_roles: ["ledger"] }).ToPayload(), { roles: [], app_roles: {} });
    assert.deepEqual(RealmRoleClaims.FromPayload({ groups: ["admin"] }, "groups").TenantRoles, ["admin"]);
    assert.deepEqual(RealmRoleClaims.FromQualified(["admin", "", "a:b:c", "ledger:sales"]).Qualified(), ["admin", "ledger:sales"]);
});
