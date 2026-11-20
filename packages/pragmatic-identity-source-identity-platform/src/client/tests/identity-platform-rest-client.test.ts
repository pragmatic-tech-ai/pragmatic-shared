import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeIdentityPlatform, FakeIdentityPlatformHttp, FakeIdentityPlatformRest } from "../../testing/index.js";
import { IdentityPlatformSettings } from "../../settings/identity-platform-settings.js";
import { IdentityPlatformSettingKeys } from "../../settings/identity-platform-setting-keys.js";
import { IdentityPlatformKeySet } from "../../token/identity-platform-key-set.js";
import { IdentityPlatformTokenVerifier } from "../../token/identity-platform-token-verifier.js";
import { IdentityPlatformRejection } from "../../token/identity-platform-rejection.js";
import { IdentityPlatformRestClient } from "../identity-platform-rest-client.js";
import { IdentityPlatformRestError } from "../identity-platform-rest-error.js";
import { IdentityPlatformPageConfig } from "../identity-platform-page-config.js";
import { IdentityPlatformProvider } from "../identity-platform-provider.js";

class Fixture
{
    public static readonly Email = "person@customer.test";
    public static readonly Password = "correct horse battery";
    public static readonly WrongPassword = "wrong horse";
    public static readonly ShortPassword = "abc";
    public static readonly Tenant = "tenant-a";
    public static readonly WrongKey = "not-the-key";
    public static readonly ApiKeyRef = "secret://key";
    public static readonly VerifyEmail = "VERIFY_EMAIL";
    public static readonly PasswordReset = "PASSWORD_RESET";
    public static readonly EmailExists = "EMAIL_EXISTS";
    public static readonly WeakPassword = "WEAK_PASSWORD";
    public static readonly InvalidCredentials = "INVALID_LOGIN_CREDENTIALS";
    public static readonly KeyInvalid = "API key not valid. Please pass a valid API key.";
    public static readonly TenantField = "tenantId";
    public static readonly ClientDir = "..";
    public static readonly TsSuffix = ".ts";
    public static readonly ImportPattern = /(?:import|export)[^;]*?from\s+["']([^"']+)["']/g;
    public static readonly RelativePrefix = "./";
    public static readonly StatusBadRequest = 400;

    public static async Make(tenant: string | null = null): Promise<{ platform: FakeIdentityPlatform; rest: FakeIdentityPlatformRest; client: IdentityPlatformRestClient; verifier: IdentityPlatformTokenVerifier }>
    {
        const platform = await FakeIdentityPlatform.Create();
        const rest = new FakeIdentityPlatformRest(platform, FakeIdentityPlatformRest.ApiKey, tenant);
        const page = new IdentityPlatformPageConfig(platform.ProjectId, FakeIdentityPlatformRest.ApiKey, platform.ProjectId, [IdentityPlatformProvider.Password], tenant);
        const client = IdentityPlatformRestClient.For(page, rest.Fetch);
        const settingsMap = new Map([
            [IdentityPlatformSettingKeys.ProjectId, platform.ProjectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
        ]);
        if (tenant !== null)
        {
            settingsMap.set(IdentityPlatformSettingKeys.TenantId, tenant);
        }
        const verifier = new IdentityPlatformTokenVerifier(IdentityPlatformSettings.From(settingsMap), new IdentityPlatformKeySet(new FakeIdentityPlatformHttp(platform)));
        return { platform, rest, client, verifier };
    }

    public static async Code(action: Promise<unknown>): Promise<string>
    {
        try
        {
            await action;
        }
        catch (error)
        {
            assert.ok(error instanceof IdentityPlatformRestError);
            return error.Code;
        }
        assert.fail();
    }
}

class RestClientTests
{
    public static Register(): void
    {
        test("sign-up, verification email, verification, sign-in: the last token passes the source", async () =>
        {
            const { rest, client, verifier } = await Fixture.Make();
            const signedUp = await client.SignUp(Fixture.Email, Fixture.Password);
            assert.equal(signedUp.Email, Fixture.Email);
            assert.ok(signedUp.Uid.length > 0);
            assert.ok(signedUp.RefreshToken.length > 0);
            assert.ok(signedUp.ExpiresInSeconds > 0);
            assert.equal((await verifier.Verify(signedUp.IdToken)).Rejection, IdentityPlatformRejection.EmailNotVerified);

            await client.SendEmailVerification(signedUp.IdToken);
            assert.deepEqual(rest.SentEmails.map(sent => [sent.RequestType, sent.Email]), [[Fixture.VerifyEmail, Fixture.Email]]);
            assert.equal((await client.Lookup(signedUp.IdToken)).EmailVerified, false);

            rest.VerifyEmail(Fixture.Email);
            const signedIn = await client.SignInWithPassword(Fixture.Email, Fixture.Password);
            assert.equal(signedIn.Uid, signedUp.Uid);
            const verification = await verifier.Verify(signedIn.IdToken);
            assert.equal(verification.Rejection, null);
            assert.equal(verification.Token!.Uid, signedUp.Uid);

            const user = await client.Lookup(signedIn.IdToken);
            assert.equal(user.Uid, signedUp.Uid);
            assert.equal(user.Email, Fixture.Email);
            assert.equal(user.EmailVerified, true);
            assert.deepEqual([...user.Providers], [IdentityPlatformProvider.Password]);
            assert.equal(user.DisplayName, null);
        });

        test("Identity Platform errors surface as their codes", async () =>
        {
            const { client } = await Fixture.Make();
            await client.SignUp(Fixture.Email, Fixture.Password);
            assert.equal(await Fixture.Code(client.SignUp(Fixture.Email, Fixture.Password)), Fixture.EmailExists);
            assert.equal(await Fixture.Code(client.SignUp(Fixture.RelativePrefix + Fixture.Email, Fixture.ShortPassword)), Fixture.WeakPassword);
            assert.equal(await Fixture.Code(client.SignInWithPassword(Fixture.Email, Fixture.WrongPassword)), Fixture.InvalidCredentials);
            const error = await client.SignInWithPassword(Fixture.Email, Fixture.WrongPassword).catch((e: unknown) => e);
            assert.ok(error instanceof IdentityPlatformRestError);
            assert.equal(error.Status, Fixture.StatusBadRequest);
        });

        test("a wrong API key is refused", async () =>
        {
            const { platform, rest } = await Fixture.Make();
            const client = new IdentityPlatformRestClient(Fixture.WrongKey, null, rest.Fetch);
            assert.ok(platform.ProjectId.length > 0);
            assert.equal(await Fixture.Code(client.SignUp(Fixture.Email, Fixture.Password)), Fixture.KeyInvalid);
        });

        test("a password reset sends the same answer whether or not the account exists", async () =>
        {
            const { rest, client } = await Fixture.Make();
            await client.SignUp(Fixture.Email, Fixture.Password);
            await client.SendPasswordReset(Fixture.Email);
            await client.SendPasswordReset(Fixture.RelativePrefix + Fixture.Email);
            assert.deepEqual(rest.SentEmails.map(sent => sent.RequestType), [Fixture.PasswordReset]);
        });

        test("an Identity Platform tenant id travels in every request", async () =>
        {
            const { rest, client, verifier } = await Fixture.Make(Fixture.Tenant);
            const session = await client.SignUp(Fixture.Email, Fixture.Password);
            await client.SendEmailVerification(session.IdToken);
            rest.VerifyEmail(Fixture.Email);
            const signedIn = await client.SignInWithPassword(Fixture.Email, Fixture.Password);
            assert.ok(rest.RequestBodies.every(body => body[Fixture.TenantField] === Fixture.Tenant));
            assert.equal((await verifier.Verify(signedIn.IdToken)).Token!.TenantId, Fixture.Tenant);
        });

        test("the client sources are browser-safe: they import only each other", () =>
        {
            const dir = join(fileURLToPath(new URL(Fixture.ClientDir, import.meta.url)));
            for (const file of readdirSync(dir).filter(name => name.endsWith(Fixture.TsSuffix)))
            {
                const source = readFileSync(join(dir, file), "utf8");
                for (const match of source.matchAll(Fixture.ImportPattern))
                {
                    assert.ok(match[1]!.startsWith(Fixture.RelativePrefix), `${file} imports ${match[1]}`);
                }
            }
        });
    }
}

RestClientTests.Register();
