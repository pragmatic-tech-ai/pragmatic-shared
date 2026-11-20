import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeOidcHttpClient, FakeOidcIdp } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing";
import { RealmTokenVerifier } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { CentralLoginTokenVerifier } from "../central-login-token-verifier.js";
import { PragmaticIdentityProfile } from "../../packs/pragmatic-identity-profile.js";

class Fixture
{
    public static readonly Audience = "pragmatic-cabinet";
    public static readonly DevIssuer = "https://login.dev.test/realms/central";
}

test("the central preset trusts the central realm's issuer by default", async () =>
{
    const verifier = new CentralLoginTokenVerifier({ Audience: Fixture.Audience });
    assert.ok(verifier instanceof RealmTokenVerifier);
    assert.equal(verifier.Issuer, PragmaticIdentityProfile.CentralIssuer);
    assert.equal(CentralLoginTokenVerifier.Issuer, PragmaticIdentityProfile.CentralIssuer);
});

test("a central-login token is verified to its principal; the issuer is overridable for tests and development stacks", async () =>
{
    const idp = await FakeOidcIdp.Create(Fixture.DevIssuer);
    const verifier = new CentralLoginTokenVerifier({ Issuer: Fixture.DevIssuer, Audience: Fixture.Audience, Http: new FakeOidcHttpClient(idp) });
    const principal = await verifier.Verify(await idp.MintIdToken({ sub: "gip-uid-1", aud: Fixture.Audience, email: "p@customer.test", email_verified: true, roles: ["admin"] }));
    assert.equal(principal?.Issuer, Fixture.DevIssuer);
    assert.equal(principal?.Subject, "gip-uid-1");
    assert.equal(principal?.Email, "p@customer.test");
    assert.deepEqual(principal?.Roles.TenantRoles, ["admin"]);
});

test("the central preset requires an email (the customer is named by it) unless told otherwise", async () =>
{
    const idp = await FakeOidcIdp.Create(Fixture.DevIssuer);
    const http = new FakeOidcHttpClient(idp);
    const token = await idp.MintIdToken({ sub: "gip-uid-1", aud: Fixture.Audience });
    assert.equal(await new CentralLoginTokenVerifier({ Issuer: Fixture.DevIssuer, Audience: Fixture.Audience, Http: http }).Verify(token), undefined);
    assert.ok(await new CentralLoginTokenVerifier({ Issuer: Fixture.DevIssuer, Audience: Fixture.Audience, Http: http, RequireEmail: false }).Verify(token));
});
