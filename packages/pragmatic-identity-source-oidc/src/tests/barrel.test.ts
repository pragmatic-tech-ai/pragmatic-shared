import { test } from "node:test";
import * as assert from "node:assert/strict";

/** The test helpers ship from the `./testing` subpath only, never from the main entry production code imports. */
class Barrel
{
    public static readonly Helpers = ["FakeOidcIdp", "FakeOidcHttpClient", "MapSecretStore"];
}

test("the main entry exports no test helper", async () =>
{
    const main = await import("@pragmatic-tech-ai/pragmatic-identity-source-oidc") as Record<string, unknown>;
    for (const helper of Barrel.Helpers)
    {
        assert.equal(main[helper], undefined, helper);
    }
    assert.equal(typeof main.OidcAuthenticator, "function");
});

test("the ./testing subpath exports every test helper", async () =>
{
    const testing = await import("@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing") as Record<string, unknown>;
    for (const helper of Barrel.Helpers)
    {
        assert.equal(typeof testing[helper], "function", helper);
    }
});
