import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeIdentityPlatform, FakeIdentityPlatformHttp } from "../../testing/index.js";
import { IdentityPlatformSettings } from "../../settings/identity-platform-settings.js";
import { IdentityPlatformSettingKeys } from "../../settings/identity-platform-setting-keys.js";
import { IdentityPlatformKeySet } from "../identity-platform-key-set.js";
import { IdentityPlatformTokenVerifier } from "../identity-platform-token-verifier.js";
import { IdentityPlatformRejection } from "../identity-platform-rejection.js";

class Fixture
{
    public static readonly ApiKeyRef = "secret://key";
    public static readonly Uid = "uid-1";
    public static readonly OneHourMs = 3_600_000;
    public static readonly OneMinuteMs = 60_000;
    public static readonly SecondMs = 1000;

    public Millis = Date.now();
    public readonly platform: FakeIdentityPlatform;
    public readonly http: FakeIdentityPlatformHttp;
    public readonly verifier: IdentityPlatformTokenVerifier;

    private constructor(platform: FakeIdentityPlatform)
    {
        this.platform = platform;
        this.http = new FakeIdentityPlatformHttp(platform);
        const settings = IdentityPlatformSettings.From(new Map([
            [IdentityPlatformSettingKeys.ProjectId, platform.ProjectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
        ]));
        const now = (): Date => new Date(this.Millis);
        this.verifier = new IdentityPlatformTokenVerifier(settings, new IdentityPlatformKeySet(this.http, now), now);
    }

    public static async Create(): Promise<Fixture>
    {
        return new Fixture(await FakeIdentityPlatform.Create());
    }

    public async Mint(): Promise<string>
    {
        const seconds = Math.floor(this.Millis / Fixture.SecondMs);
        return this.platform.MintIdToken({ Uid: Fixture.Uid }, { IssuedAt: seconds });
    }
}

class KeySetTests
{
    public static Register(): void
    {
        test("the key set targets Google's securetoken JWKS", () =>
        {
            assert.equal(IdentityPlatformKeySet.SecuretokenJwksUri, FakeIdentityPlatform.SecuretokenJwksUri);
        });

        test("the JWKS is fetched once and cached", async () =>
        {
            const fixture = await Fixture.Create();
            for (let i = 0; i < 3; i++)
            {
                assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, null);
            }
            assert.equal(fixture.http.JwksFetches, 1);
        });

        test("the cache expires after an hour", async () =>
        {
            const fixture = await Fixture.Create();
            await fixture.verifier.Verify(await fixture.Mint());
            fixture.Millis += Fixture.OneHourMs + Fixture.SecondMs;
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, null);
            assert.equal(fixture.http.JwksFetches, 2);
        });

        test("an unknown key id after Google's rotation refetches the JWKS once", async () =>
        {
            const fixture = await Fixture.Create();
            await fixture.verifier.Verify(await fixture.Mint());
            await fixture.platform.RotateKey();
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, null);
            assert.equal(fixture.http.JwksFetches, 2);
        });

        test("refetches on unknown key ids are throttled to one a minute", async () =>
        {
            const fixture = await Fixture.Create();
            await fixture.verifier.Verify(await fixture.Mint());
            await fixture.platform.RotateKey();
            await fixture.verifier.Verify(await fixture.Mint());
            await fixture.platform.RotateKey();
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, IdentityPlatformRejection.UnknownKey);
            assert.equal(fixture.http.JwksFetches, 2);
            fixture.Millis += Fixture.OneMinuteMs + Fixture.SecondMs;
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, null);
            assert.equal(fixture.http.JwksFetches, 3);
        });

        test("a failed fetch is not cached", async () =>
        {
            const fixture = await Fixture.Create();
            fixture.http.Unavailable = true;
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, IdentityPlatformRejection.KeysUnavailable);
            fixture.http.Unavailable = false;
            assert.equal((await fixture.verifier.Verify(await fixture.Mint())).Rejection, null);
        });
    }
}

KeySetTests.Register();
