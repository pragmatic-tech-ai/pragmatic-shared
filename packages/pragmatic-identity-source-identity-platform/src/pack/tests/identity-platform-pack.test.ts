import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditEventKind, AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Realm, RealmKind, RejectedResult } from "@pragmatic-tech-ai/pragmatic-identity";
import type { IIdentityProviderPack } from "@pragmatic-tech-ai/pragmatic-identity";
import { FakeAuditSink, FakeRoleGrantStore, FakeSessionManager, IdentityPackConformance } from "@pragmatic-tech-ai/pragmatic-identity/testing";
import { MapSecretStore } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing";
import { FakeIdentityPlatform, FakeIdentityPlatformHttp } from "../../testing/index.js";
import { IdentityPlatformProvider } from "../../client/identity-platform-provider.js";
import { IdentityPlatformPageConfig } from "../../client/identity-platform-page-config.js";
import { IdentityPlatformSettingKeys } from "../../settings/identity-platform-setting-keys.js";
import { IdentityPlatformPack } from "../identity-platform-pack.js";

class Fixture
{
    public static readonly PackId = "identity-platform";
    public static readonly ApiKeyRef = "secret://central-login/gip-browser-key";
    public static readonly ApiKey = "browser-key-value";
    public static readonly Uid = "uid-1";
    public static readonly Email = "person@customer.test";
    public static readonly Name = "A Person";
    public static readonly RealmId = "central";
    public static readonly RealmName = "Central";
    public static readonly ProvidersBoth = "password,google.com";
    public static readonly SourceRef = "identity-platform";
    public static readonly EmailClaim = "email";
    public static readonly NameClaim = "name";
    public static readonly EmailVerifiedClaim = "email_verified";
    public static readonly ProviderClaim = "sign_in_provider";
    public static readonly True = "true";
    public static readonly MethodKey = "method";
    public static readonly ProviderKey = "provider";
    public static readonly MethodValue = "identity-platform";
    public static readonly GenericReason = "authentication failed";
    public static readonly UnverifiedReason = "email not verified";
    public static readonly MissingSecret = /API key secret is missing/;
    public static readonly Label = "IdentityPlatformPack";

    public static Settings(projectId: string, providers?: string): Map<string, string>
    {
        const settings = new Map([
            [IdentityPlatformSettingKeys.ProjectId, projectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
        ]);
        if (providers !== undefined)
        {
            settings.set(IdentityPlatformSettingKeys.Providers, providers);
        }
        return settings;
    }

    public static Realm(): Realm
    {
        return new Realm(Fixture.RealmId, RealmKind.Saas, Fixture.RealmName);
    }

    public static async Make(depth: DelegationDepth = DelegationDepth.AuthnDirectory, providers?: string): Promise<{ platform: FakeIdentityPlatform; pack: IdentityPlatformPack; audit: FakeAuditSink }>
    {
        const platform = await FakeIdentityPlatform.Create();
        const audit = new FakeAuditSink();
        const pack = IdentityPlatformPack.Create({
            Config: new IdentityConfig(Fixture.PackId, depth, Fixture.Settings(platform.ProjectId, providers), new Map(), new Map()),
            Http: new FakeIdentityPlatformHttp(platform),
            Sessions: new FakeSessionManager(),
            Grants: new FakeRoleGrantStore(),
            Audit: audit,
        });
        return { platform, pack, audit };
    }

    public static Authenticate(pack: IdentityPlatformPack, idToken: string): ReturnType<IdentityPlatformPack["Authenticators"][number]["Authenticate"]>
    {
        return pack.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, Fixture.SourceRef), new PresentedSecret(idToken), Fixture.Realm());
    }
}

class PackTests
{
    public static Register(): void
    {
        test("a verified ID token signs the person in as the realm account uid", async () =>
        {
            const { platform, pack } = await Fixture.Make();
            const result = await Fixture.Authenticate(pack, await platform.MintIdToken({ Uid: Fixture.Uid, Email: Fixture.Email, Name: Fixture.Name }));
            assert.ok(result instanceof AuthenticatedResult);
            const principal = (result as AuthenticatedResult).Principal;
            assert.equal(principal.Id, Fixture.Uid);
            assert.equal(principal.RealmId, Fixture.RealmId);
            assert.equal(principal.Claim(Fixture.EmailClaim), Fixture.Email);
            assert.equal(principal.Claim(Fixture.NameClaim), Fixture.Name);
            assert.equal(principal.Claim(Fixture.EmailVerifiedClaim), Fixture.True);
            assert.equal(principal.Claim(Fixture.ProviderClaim), IdentityPlatformProvider.Password);
            assert.deepEqual([...principal.Groups], []);
            assert.equal((await pack.Directory.Lookup(Fixture.Uid, Fixture.Realm()))?.Id, Fixture.Uid);
        });

        test("the sign-in is audited with its provider, never with the token", async () =>
        {
            const { platform, pack, audit } = await Fixture.Make();
            const idToken = await platform.MintIdToken({ Uid: Fixture.Uid });
            await Fixture.Authenticate(pack, idToken);
            const event = audit.Events.find(e => e.Kind === AuditEventKind.Authentication)!;
            assert.equal(event.PrincipalId, Fixture.Uid);
            assert.equal(event.Detail.get(Fixture.MethodKey), Fixture.MethodValue);
            assert.equal(event.Detail.get(Fixture.ProviderKey), IdentityPlatformProvider.Password);
            for (const value of event.Detail.values())
            {
                assert.ok(!value.includes(idToken));
            }
        });

        test("an unverified email is told apart; every other failure has one reason", async () =>
        {
            const { platform, pack, audit } = await Fixture.Make();
            const unverified = await Fixture.Authenticate(pack, await platform.MintIdToken({ Uid: Fixture.Uid, EmailVerified: false }));
            assert.ok(unverified instanceof RejectedResult);
            assert.equal((unverified as RejectedResult).Reason, Fixture.UnverifiedReason);
            const foreign = await Fixture.Authenticate(pack, await platform.MintIdToken({ Uid: Fixture.Uid }, { ForeignKey: true }));
            assert.equal((foreign as RejectedResult).Reason, Fixture.GenericReason);
            const google = await Fixture.Authenticate(pack, await platform.MintIdToken({ Uid: Fixture.Uid, SignInProvider: IdentityPlatformProvider.Google }));
            assert.equal((google as RejectedResult).Reason, Fixture.GenericReason);
            assert.equal(audit.Events.length, 0);
        });

        test("the client config carries what the login page needs, the API key as a reference", async () =>
        {
            const { platform, pack } = await Fixture.Make(DelegationDepth.AuthnDirectory, Fixture.ProvidersBoth);
            const config = pack.ClientConfig;
            assert.equal(config.ProjectId, platform.ProjectId);
            assert.equal(config.ApiKeyRef, Fixture.ApiKeyRef);
            assert.deepEqual([...config.Providers], [IdentityPlatformProvider.Password, IdentityPlatformProvider.Google]);
            assert.equal(config.TenantId, null);
            const secrets = new MapSecretStore();
            await assert.rejects(config.Resolve(secrets), Fixture.MissingSecret);
            await secrets.Put(Fixture.ApiKeyRef, Fixture.ApiKey);
            const page = await config.Resolve(secrets);
            assert.equal(page.ApiKey, Fixture.ApiKey);
            const roundTripped = IdentityPlatformPageConfig.FromJson(JSON.parse(JSON.stringify(page.ToJson())));
            assert.deepEqual(roundTripped, page);
        });

        test("the pack reports the configured delegation depth", async () =>
        {
            const { pack } = await Fixture.Make(DelegationDepth.ExternalGrants);
            assert.equal(pack.DelegationDepth, DelegationDepth.ExternalGrants);
            assert.equal(pack.Policy, undefined);
        });

        IdentityPackConformance.Describe(Fixture.Label, () => PackTests.ConformancePack());
    }

    private static ConformancePack(): IIdentityProviderPack
    {
        const platformProject = FakeIdentityPlatform.DefaultProjectId;
        return IdentityPlatformPack.Create({
            Config: new IdentityConfig(Fixture.PackId, DelegationDepth.AuthnDirectory, Fixture.Settings(platformProject), new Map(), new Map()),
            Http: { GetJson: () => Promise.resolve({ keys: [] }), PostForm: () => Promise.resolve({}) },
            Sessions: new FakeSessionManager(),
            Grants: new FakeRoleGrantStore(),
            Audit: new FakeAuditSink(),
        });
    }
}

PackTests.Register();
