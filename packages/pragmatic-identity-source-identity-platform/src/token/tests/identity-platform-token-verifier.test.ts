import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeIdentityPlatform, FakeIdentityPlatformHttp } from "../../testing/index.js";
import type { FakeIdTokenClaims, FakeMintOptions } from "../../testing/index.js";
import { IdentityPlatformProvider } from "../../client/identity-platform-provider.js";
import { IdentityPlatformSettings } from "../../settings/identity-platform-settings.js";
import { IdentityPlatformSettingKeys } from "../../settings/identity-platform-setting-keys.js";
import { IdentityPlatformKeySet } from "../identity-platform-key-set.js";
import { IdentityPlatformRejection } from "../identity-platform-rejection.js";
import { IdentityPlatformTokenVerifier } from "../identity-platform-token-verifier.js";

class Clock
{
    public Millis = Date.now();

    public get Seconds(): number
    {
        return Math.floor(this.Millis / 1000);
    }

    public Now(): Date
    {
        return new Date(this.Millis);
    }
}

class Fixture
{
    public static readonly ApiKeyRef = "secret://central-login/gip-browser-key";
    public static readonly Uid = "uid-1";
    public static readonly Email = "person@customer.test";
    public static readonly Name = "A Person";
    public static readonly Tenant = "tenant-a";
    public static readonly OtherProject = "someone-else";
    public static readonly ProvidersBoth = "password,google.com";
    public static readonly GoogleIssuer = "https://accounts.google.com";
    public static readonly UnknownKid = "not-a-published-kid";
    public static readonly Anonymous = "anonymous";
    public static readonly HourSeconds = 3600;
    public static readonly HalfHourSeconds = 1800;
    public static readonly FiveMinutes = 300;
    public static readonly TenMinutesPlus = 601;
    public static readonly Garbage = "deny";
    public static readonly NoneAlg = "none";
    public static readonly Dot = ".";
    private static readonly Base64Url = "base64url";

    public static Segment(value: object): string
    {
        return Buffer.from(JSON.stringify(value)).toString(Fixture.Base64Url);
    }

    public static async Make(extra?: ReadonlyArray<[string, string]>): Promise<{ platform: FakeIdentityPlatform; http: FakeIdentityPlatformHttp; verifier: IdentityPlatformTokenVerifier; clock: Clock }>
    {
        const platform = await FakeIdentityPlatform.Create();
        const http = new FakeIdentityPlatformHttp(platform);
        const clock = new Clock();
        const settings = IdentityPlatformSettings.From(new Map<string, string>([
            [IdentityPlatformSettingKeys.ProjectId, platform.ProjectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
            ...(extra ?? []),
        ]));
        const keys = new IdentityPlatformKeySet(http, () => clock.Now());
        return { platform, http, verifier: new IdentityPlatformTokenVerifier(settings, keys, () => clock.Now()), clock };
    }

    public static async Rejection(claims: FakeIdTokenClaims, opts?: FakeMintOptions, extra?: ReadonlyArray<[string, string]>): Promise<IdentityPlatformRejection | null>
    {
        const { platform, verifier } = await Fixture.Make(extra);
        const verification = await verifier.Verify(await platform.MintIdToken(claims, opts));
        return verification.Rejection;
    }
}

class VerifierTests
{
    public static Register(): void
    {
        test("a verified password account's token is accepted and read", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make();
            const token = await platform.MintIdToken({ Uid: Fixture.Uid, Email: Fixture.Email, Name: Fixture.Name, AuthTime: clock.Seconds - 5 }, { IssuedAt: clock.Seconds });
            const verification = await verifier.Verify(token);
            assert.equal(verification.Rejection, null);
            assert.ok(verification.IsVerified);
            const read = verification.Token!;
            assert.equal(read.Uid, Fixture.Uid);
            assert.equal(read.Email, Fixture.Email);
            assert.equal(read.EmailVerified, true);
            assert.equal(read.DisplayName, Fixture.Name);
            assert.equal(read.SignInProvider, IdentityPlatformProvider.Password);
            assert.equal(read.AuthTime.getTime(), (clock.Seconds - 5) * 1000);
            assert.equal(read.TenantId, null);
        });

        test("the issuer must be securetoken.google.com/<project>", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, { Issuer: Fixture.GoogleIssuer }), IdentityPlatformRejection.WrongIssuer);
        });

        test("the audience must be the project id", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, { Audience: Fixture.OtherProject }), IdentityPlatformRejection.WrongAudience);
        });

        test("a token signed by a key the JWKS does not hold is rejected", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, { ForeignKey: true }), IdentityPlatformRejection.BadSignature);
        });

        test("a token under an unknown key id is rejected", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, { Kid: Fixture.UnknownKid }), IdentityPlatformRejection.UnknownKey);
        });

        test("garbage and unsigned tokens are rejected as malformed", async () =>
        {
            const { verifier } = await Fixture.Make();
            assert.equal((await verifier.Verify(Fixture.Garbage)).Rejection, IdentityPlatformRejection.Malformed);
            const unsigned = Fixture.Segment({ alg: Fixture.NoneAlg }) + Fixture.Dot + Fixture.Segment({}) + Fixture.Dot;
            assert.equal((await verifier.Verify(unsigned)).Rejection, IdentityPlatformRejection.WrongAlgorithm);
        });

        test("an expired token is rejected", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make();
            const token = await platform.MintIdToken({ Uid: Fixture.Uid }, { IssuedAt: clock.Seconds - 2 * Fixture.HourSeconds, ExpiresAt: clock.Seconds - Fixture.HourSeconds });
            assert.equal((await verifier.Verify(token)).Rejection, IdentityPlatformRejection.Expired);
        });

        test("a token without exp is rejected", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, { NoExpiry: true }), IdentityPlatformRejection.Malformed);
        });

        test("a token issued in the future is rejected", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make();
            const token = await platform.MintIdToken({ Uid: Fixture.Uid, AuthTime: clock.Seconds }, { IssuedAt: clock.Seconds + Fixture.FiveMinutes });
            assert.equal((await verifier.Verify(token)).Rejection, IdentityPlatformRejection.IssuedInFuture);
        });

        test("an auth_time in the future is rejected", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make();
            const token = await platform.MintIdToken({ Uid: Fixture.Uid, AuthTime: clock.Seconds + Fixture.FiveMinutes }, { IssuedAt: clock.Seconds });
            assert.equal((await verifier.Verify(token)).Rejection, IdentityPlatformRejection.AuthTimeInFuture);
        });

        test("a sign-in older than the maximum age (default ten minutes) is rejected", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make();
            const token = await platform.MintIdToken({ Uid: Fixture.Uid, AuthTime: clock.Seconds - Fixture.TenMinutesPlus }, { IssuedAt: clock.Seconds });
            assert.equal((await verifier.Verify(token)).Rejection, IdentityPlatformRejection.SignInTooOld);
        });

        test("the maximum sign-in age is a setting", async () =>
        {
            const { platform, verifier, clock } = await Fixture.Make([[IdentityPlatformSettingKeys.MaxAuthAgeSeconds, String(Fixture.HourSeconds)]]);
            const token = await platform.MintIdToken({ Uid: Fixture.Uid, AuthTime: clock.Seconds - Fixture.HalfHourSeconds }, { IssuedAt: clock.Seconds });
            assert.equal((await verifier.Verify(token)).Rejection, null);
        });

        test("a token without a subject is rejected", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: "" }), IdentityPlatformRejection.NoSubject);
        });

        test("a password account with an unverified email is rejected", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, EmailVerified: false }), IdentityPlatformRejection.EmailNotVerified);
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, Email: null }), IdentityPlatformRejection.EmailNotVerified);
        });

        test("a provider the realm has not enabled is rejected; anonymous never passes", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, SignInProvider: IdentityPlatformProvider.Google }), IdentityPlatformRejection.ProviderNotEnabled);
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, SignInProvider: Fixture.Anonymous }), IdentityPlatformRejection.ProviderNotEnabled);
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, SignInProvider: Fixture.Anonymous }, undefined, [[IdentityPlatformSettingKeys.Providers, Fixture.ProvidersBoth]]), IdentityPlatformRejection.ProviderNotEnabled);
        });

        test("an enabled Google sign-in is accepted and its provider recorded", async () =>
        {
            const { platform, verifier } = await Fixture.Make([[IdentityPlatformSettingKeys.Providers, Fixture.ProvidersBoth]]);
            const verification = await verifier.Verify(await platform.MintIdToken({ Uid: Fixture.Uid, SignInProvider: IdentityPlatformProvider.Google }));
            assert.equal(verification.Rejection, null);
            assert.equal(verification.Token!.SignInProvider, IdentityPlatformProvider.Google);
        });

        test("the tenant must match the configured Identity Platform tenant, or be absent when none is configured", async () =>
        {
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, Tenant: Fixture.Tenant }), IdentityPlatformRejection.WrongTenant);
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid }, undefined, [[IdentityPlatformSettingKeys.TenantId, Fixture.Tenant]]), IdentityPlatformRejection.WrongTenant);
            assert.equal(await Fixture.Rejection({ Uid: Fixture.Uid, Tenant: Fixture.Tenant }, undefined, [[IdentityPlatformSettingKeys.TenantId, Fixture.Tenant]]), null);
        });

        test("keys that cannot be fetched fail closed", async () =>
        {
            const { platform, http, verifier } = await Fixture.Make();
            http.Unavailable = true;
            assert.equal((await verifier.Verify(await platform.MintIdToken({ Uid: Fixture.Uid }))).Rejection, IdentityPlatformRejection.KeysUnavailable);
        });
    }
}

VerifierTests.Register();
