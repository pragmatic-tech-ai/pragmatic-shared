import { test } from "node:test";
import * as assert from "node:assert/strict";

/** The test helpers ship from the `./testing` subpath only; the login page's helpers from `./client`. */
class Barrel
{
    public static readonly Helpers = ["FakeIdentityPlatform", "FakeIdentityPlatformHttp", "FakeIdentityPlatformRest", "FakeFederatedPerson"];
    public static readonly ClientExports = ["IdentityPlatformRestClient", "IdentityPlatformRestError", "IdentityPlatformPageConfig", "IdentityPlatformSession", "IdentityPlatformUser", "IdentityPlatformIdpSession", "IdentityPlatformAuthUri", "IdentityPlatformHttpResponse", "FetchIdentityPlatformHttp"];
    public static readonly MainExports = ["IdentityPlatformPack", "IdentityPlatformTokenVerifier", "IdentityPlatformKeySet", "IdentityPlatformSettings", "IdentityPlatformClientConfig", "IdentityPlatformPageConfig"];
    public static readonly Main = "@pragmatic-tech-ai/pragmatic-identity-source-identity-platform";
    public static readonly Client = "@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client";
    public static readonly Testing = "@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/testing";
    public static readonly Function = "function";
}

test("the main entry exports the source and no test helper", async () =>
{
    const main = await import(Barrel.Main) as Record<string, unknown>;
    for (const helper of Barrel.Helpers)
    {
        assert.equal(main[helper], undefined, helper);
    }
    for (const name of Barrel.MainExports)
    {
        assert.equal(typeof main[name], Barrel.Function, name);
    }
});

test("the ./client subpath exports the login page's helpers", async () =>
{
    const client = await import(Barrel.Client) as Record<string, unknown>;
    for (const name of Barrel.ClientExports)
    {
        assert.equal(typeof client[name], Barrel.Function, name);
    }
});

test("the ./testing subpath exports every test helper", async () =>
{
    const testing = await import(Barrel.Testing) as Record<string, unknown>;
    for (const helper of Barrel.Helpers)
    {
        assert.equal(typeof testing[helper], Barrel.Function, helper);
    }
});
