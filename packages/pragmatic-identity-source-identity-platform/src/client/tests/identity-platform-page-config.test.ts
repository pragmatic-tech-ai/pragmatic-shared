import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityPlatformPageConfig } from "../identity-platform-page-config.js";
import { IdentityPlatformProvider } from "../identity-platform-provider.js";

class Fixture
{
    public static readonly ProjectId = "project-1";
    public static readonly ApiKey = "browser-key";
    public static readonly AuthDomain = "project-1.firebaseapp.com";
    public static readonly Tenant = "tenant-1";
    public static readonly Anonymous = "anonymous";
    public static readonly Invalid = /invalid Identity Platform page config/;

    public static Json(): Record<string, unknown>
    {
        return {
            projectId: Fixture.ProjectId,
            apiKey: Fixture.ApiKey,
            authDomain: Fixture.AuthDomain,
            providers: [IdentityPlatformProvider.Password, IdentityPlatformProvider.Google],
            tenantId: Fixture.Tenant,
        };
    }
}

class PageConfigTests
{
    public static Register(): void
    {
        test("the page config reads its JSON form and says which providers it enables", () =>
        {
            const config = IdentityPlatformPageConfig.FromJson(Fixture.Json());
            assert.equal(config.ProjectId, Fixture.ProjectId);
            assert.equal(config.ApiKey, Fixture.ApiKey);
            assert.equal(config.AuthDomain, Fixture.AuthDomain);
            assert.equal(config.TenantId, Fixture.Tenant);
            assert.ok(config.Enables(IdentityPlatformProvider.Google));
            assert.deepEqual(config.ToJson(), Fixture.Json());
        });

        test("a malformed page config is refused", () =>
        {
            const broken: Array<unknown> = [
                null,
                Fixture.ProjectId,
                { ...Fixture.Json(), projectId: 7 },
                { ...Fixture.Json(), apiKey: undefined },
                { ...Fixture.Json(), authDomain: null },
                { ...Fixture.Json(), providers: IdentityPlatformProvider.Password },
                { ...Fixture.Json(), providers: [Fixture.Anonymous] },
                { ...Fixture.Json(), tenantId: 3 },
            ];
            for (const json of broken)
            {
                assert.throws(() => IdentityPlatformPageConfig.FromJson(json), Fixture.Invalid);
            }
        });
    }
}

PageConfigTests.Register();
