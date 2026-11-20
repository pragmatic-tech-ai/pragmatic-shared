import { test } from "node:test";
import assert from "node:assert/strict";
import { IdentityPlatformProvider } from "../../client/identity-platform-provider.js";
import { IdentityPlatformSettings } from "../identity-platform-settings.js";
import { IdentityPlatformSettingKeys } from "../identity-platform-setting-keys.js";

class Fixture
{
    public static readonly ProjectId = "pragmatic-identity";
    public static readonly ApiKeyRef = "secret://central-login/gip-browser-key";
    public static readonly Issuer = "https://securetoken.google.com/pragmatic-identity";
    public static readonly DefaultAuthDomain = "pragmatic-identity.firebaseapp.com";
    public static readonly AuthDomain = "login.pragmatic-tech.ai";
    public static readonly Tenant = "tenant-a";
    public static readonly Providers = " google.com , password ";
    public static readonly UnknownProvider = "password,facebook.com";
    public static readonly Anonymous = "anonymous";
    public static readonly NotANumber = "ten";
    public static readonly MaxAge = "120";
    public static readonly DefaultMaxAge = 600;
    public static readonly RequiredPrefix = /Identity Platform setting is required: /;
    public static readonly InvalidPrefix = /Identity Platform setting is invalid: /;

    public static Base(): Map<string, string>
    {
        return new Map([
            [IdentityPlatformSettingKeys.ProjectId, Fixture.ProjectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
        ]);
    }
}

class SettingsTests
{
    public static Register(): void
    {
        test("defaults: password only, ten-minute sign-in age, the project's firebaseapp auth domain, no tenant", () =>
        {
            const settings = IdentityPlatformSettings.From(Fixture.Base());
            assert.equal(settings.ProjectId, Fixture.ProjectId);
            assert.equal(settings.ApiKeyRef, Fixture.ApiKeyRef);
            assert.equal(settings.Issuer, Fixture.Issuer);
            assert.deepEqual([...settings.Providers], [IdentityPlatformProvider.Password]);
            assert.equal(settings.MaxAuthAgeSeconds, Fixture.DefaultMaxAge);
            assert.equal(settings.AuthDomain, Fixture.DefaultAuthDomain);
            assert.equal(settings.TenantId, null);
        });

        test("every optional setting is read", () =>
        {
            const map = Fixture.Base();
            map.set(IdentityPlatformSettingKeys.Providers, Fixture.Providers);
            map.set(IdentityPlatformSettingKeys.TenantId, Fixture.Tenant);
            map.set(IdentityPlatformSettingKeys.MaxAuthAgeSeconds, Fixture.MaxAge);
            map.set(IdentityPlatformSettingKeys.AuthDomain, Fixture.AuthDomain);
            const settings = IdentityPlatformSettings.From(map);
            assert.deepEqual([...settings.Providers], [IdentityPlatformProvider.Google, IdentityPlatformProvider.Password]);
            assert.equal(settings.TenantId, Fixture.Tenant);
            assert.equal(settings.MaxAuthAgeSeconds, Number(Fixture.MaxAge));
            assert.equal(settings.AuthDomain, Fixture.AuthDomain);
        });

        test("the project id and the API key reference are required", () =>
        {
            for (const key of [IdentityPlatformSettingKeys.ProjectId, IdentityPlatformSettingKeys.ApiKeyRef])
            {
                const map = Fixture.Base();
                map.delete(key);
                assert.throws(() => IdentityPlatformSettings.From(map), Fixture.RequiredPrefix);
            }
        });

        test("unknown or anonymous providers and a non-numeric age are refused", () =>
        {
            for (const [key, value] of [
                [IdentityPlatformSettingKeys.Providers, Fixture.UnknownProvider],
                [IdentityPlatformSettingKeys.Providers, Fixture.Anonymous],
                [IdentityPlatformSettingKeys.MaxAuthAgeSeconds, Fixture.NotANumber],
            ] as const)
            {
                const map = Fixture.Base();
                map.set(key, value);
                assert.throws(() => IdentityPlatformSettings.From(map), Fixture.InvalidPrefix);
            }
        });
    }
}

SettingsTests.Register();
