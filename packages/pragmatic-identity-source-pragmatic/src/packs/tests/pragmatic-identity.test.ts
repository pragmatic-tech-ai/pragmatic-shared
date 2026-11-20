import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthMethod, AuthenticatedResult, Credential, DelegationDepth, IdentityConfig, PresentedSecret, Realm, RealmKind, RejectedResult } from "@pragmatic-tech-ai/pragmatic-identity";
import type { IIdentityProviderPack } from "@pragmatic-tech-ai/pragmatic-identity";
import { FakeAuditSink, FakeRoleGrantStore, FakeSessionManager, IdentityPackConformance } from "@pragmatic-tech-ai/pragmatic-identity/testing";
import { InMemoryOidcFlowStateStore, OidcSettingKeys } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import type { IHttpClient } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { FakeOidcHttpClient, FakeOidcIdp, MapSecretStore } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing";
import { PragmaticIdentityPack } from "../pragmatic-identity-pack.js";
import { PragmaticIdentityProfile } from "../pragmatic-identity-profile.js";

class NoNetworkHttp implements IHttpClient
{
    private static readonly NoNetwork = "no network in conformance";

    public async GetJson(_url: string, _bearer?: string): Promise<unknown>
    {
        throw new Error(NoNetworkHttp.NoNetwork);
    }

    public async PostForm(_url: string, _fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        throw new Error(NoNetworkHttp.NoNetwork);
    }
}

class Fixture
{
    public static readonly ClientId = "personal-cabinet";
    public static readonly RedirectUri = "https://cabinet.test/callback";
    public static readonly PackId = "pragmatic";
    public static readonly CentralIssuer = "https://login.pragmatic-tech.ai/realms/central";
    public static readonly DevIssuer = "https://login.dev.test/realms/central";
    public static readonly OtherIssuer = "https://evil.example/realms/central";
    public static readonly Subject = "gip-uid-1";
    public static readonly Email = "person@customer.test";
    public static readonly Name = "A Person";
    public static readonly Role = "admin";
    public static readonly AuthCode = "code-1";
    public static readonly RealmRef = "t1";
    public static readonly RealmName = "Acme";
    public static readonly EmailClaim = "email";
    public static readonly NameClaim = "name";
    public static readonly RolesClaim = "roles";
    public static readonly WellKnown = "/.well-known/openid-configuration";
    public static readonly TrailingSlash = "/";
    public static readonly Scopes = ["openid", "profile", "email"];
    public static readonly Label = "PragmaticIdentityPack";

    public static Settings(issuer?: string): Map<string, string>
    {
        const settings = new Map([
            [OidcSettingKeys.ClientId, Fixture.ClientId],
            [OidcSettingKeys.RedirectUri, Fixture.RedirectUri],
        ]);
        if (issuer !== undefined)
        {
            settings.set(OidcSettingKeys.Issuer, issuer);
        }
        return settings;
    }

    public static Pack(idp: FakeOidcIdp, flowStates: InMemoryOidcFlowStateStore, http: FakeOidcHttpClient): PragmaticIdentityPack
    {
        return PragmaticIdentityPack.Create({
            Config: new IdentityConfig(Fixture.PackId, DelegationDepth.ExternalGrants, Fixture.Settings(idp.Issuer), new Map(), new Map()),
            Http: http,
            FlowStates: flowStates,
            Secrets: new MapSecretStore(),
            Sessions: new FakeSessionManager(),
            Grants: new FakeRoleGrantStore(),
            Audit: new FakeAuditSink(),
        });
    }

    public static Realm(): Realm
    {
        return new Realm(Fixture.RealmRef, RealmKind.Saas, Fixture.RealmName);
    }
}

class PragmaticIdentityTests
{
    public static Register(): void
    {
        test("the profile points at the central realm by default", () =>
        {
            const profile = new PragmaticIdentityProfile();
            assert.equal(PragmaticIdentityProfile.CentralIssuer, Fixture.CentralIssuer);
            assert.equal(profile.ResolveIssuer(Fixture.Settings()), Fixture.CentralIssuer);
            assert.equal(profile.ResolveDiscoveryUrl(Fixture.Settings()), Fixture.CentralIssuer + Fixture.WellKnown);
        });

        test("the issuer setting overrides the central realm (tests, dev)", () =>
        {
            const profile = new PragmaticIdentityProfile();
            assert.equal(profile.ResolveIssuer(Fixture.Settings(Fixture.DevIssuer)), Fixture.DevIssuer);
            assert.equal(profile.ResolveDiscoveryUrl(Fixture.Settings(Fixture.DevIssuer + Fixture.TrailingSlash)), Fixture.DevIssuer + Fixture.WellKnown);
        });

        test("the profile asks for openid, profile and email, maps email and name, and takes groups from roles", () =>
        {
            const profile = new PragmaticIdentityProfile();
            assert.deepEqual([...profile.DefaultScopes], Fixture.Scopes);
            assert.equal(profile.DefaultClaimsMapping.get(Fixture.EmailClaim), Fixture.EmailClaim);
            assert.equal(profile.DefaultClaimsMapping.get(Fixture.NameClaim), Fixture.NameClaim);
            assert.deepEqual([...profile.GroupStrategy.GroupsFrom({ [Fixture.RolesClaim]: [Fixture.Role, 7] })], [Fixture.Role]);
        });

        test("Sign in with Pragmatic authenticates a central-realm token and maps its roles", async () =>
        {
            const idp = await FakeOidcIdp.Create(Fixture.DevIssuer);
            const http = new FakeOidcHttpClient(idp);
            const flowStates = new InMemoryOidcFlowStateStore();
            const pack = Fixture.Pack(idp, flowStates, http);
            const realm = Fixture.Realm();
            const { Url, State } = await pack.BeginAuthorization(realm);
            assert.ok(Url.startsWith(idp.AuthorizationEndpoint));
            const nonce = flowStates.Peek(State)!.Nonce;
            http.NextTokenResponse = idp.TokenResponse(await idp.MintIdToken({
                sub: Fixture.Subject,
                aud: Fixture.ClientId,
                nonce,
                [Fixture.EmailClaim]: Fixture.Email,
                [Fixture.NameClaim]: Fixture.Name,
                [Fixture.RolesClaim]: [Fixture.Role],
            }));
            const result = await pack.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, State), new PresentedSecret(Fixture.AuthCode), realm);
            assert.ok(result instanceof AuthenticatedResult);
            const principal = (result as AuthenticatedResult).Principal;
            assert.equal(principal.Id, Fixture.Subject);
            assert.equal(principal.Claim(Fixture.EmailClaim), Fixture.Email);
            assert.equal(principal.Claim(Fixture.NameClaim), Fixture.Name);
            assert.deepEqual([...principal.Groups], [Fixture.Role]);
        });

        test("a token from another issuer is rejected", async () =>
        {
            const idp = await FakeOidcIdp.Create(Fixture.DevIssuer);
            const http = new FakeOidcHttpClient(idp);
            const flowStates = new InMemoryOidcFlowStateStore();
            const pack = Fixture.Pack(idp, flowStates, http);
            const realm = Fixture.Realm();
            const { State } = await pack.BeginAuthorization(realm);
            const nonce = flowStates.Peek(State)!.Nonce;
            http.NextTokenResponse = idp.TokenResponse(await idp.MintIdToken({ sub: Fixture.Subject, aud: Fixture.ClientId, nonce }, { issuer: Fixture.OtherIssuer }));
            const result = await pack.AuthenticatorFor(AuthMethod.Oidc)!.Authenticate(new Credential(AuthMethod.Oidc, State), new PresentedSecret(Fixture.AuthCode), realm);
            assert.ok(result instanceof RejectedResult);
        });

        IdentityPackConformance.Describe(Fixture.Label, () => PragmaticIdentityTests.ConformancePack());
    }

    private static ConformancePack(): IIdentityProviderPack
    {
        return PragmaticIdentityPack.Create({
            Config: new IdentityConfig(Fixture.PackId, DelegationDepth.AuthnDirectory, Fixture.Settings(), new Map(), new Map()),
            Http: new NoNetworkHttp(),
            FlowStates: new InMemoryOidcFlowStateStore(),
            Secrets: new MapSecretStore(),
            Sessions: new FakeSessionManager(),
            Grants: new FakeRoleGrantStore(),
            Audit: new FakeAuditSink(),
        });
    }
}

PragmaticIdentityTests.Register();
