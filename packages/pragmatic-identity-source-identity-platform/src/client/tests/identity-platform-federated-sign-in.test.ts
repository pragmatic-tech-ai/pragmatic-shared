import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFederatedPerson, FakeIdentityPlatform, FakeIdentityPlatformHttp, FakeIdentityPlatformRest } from "../../testing/index.js";
import { IdentityPlatformSettings } from "../../settings/identity-platform-settings.js";
import { IdentityPlatformSettingKeys } from "../../settings/identity-platform-setting-keys.js";
import { IdentityPlatformKeySet } from "../../token/identity-platform-key-set.js";
import { IdentityPlatformTokenVerifier } from "../../token/identity-platform-token-verifier.js";
import { IdentityPlatformRestClient } from "../identity-platform-rest-client.js";
import { IdentityPlatformRestError } from "../identity-platform-rest-error.js";
import { IdentityPlatformPageConfig } from "../identity-platform-page-config.js";
import { IdentityPlatformProvider } from "../identity-platform-provider.js";
import { FetchIdentityPlatformHttp } from "../fetch-identity-platform-http.js";
import { IdentityPlatformHttpResponse } from "../identity-platform-http.js";
import type { IIdentityPlatformHttp } from "../identity-platform-http.js";

class Fixture
{
    public static readonly Email = "person@pragmatic-tech.test";
    public static readonly OtherEmail = "other@pragmatic-tech.test";
    public static readonly Name = "A Person";
    public static readonly Password = "correct horse battery";
    public static readonly ContinueUri = "https://login.pragmatic-tech.test/__/auth/handler";
    public static readonly ElsewhereUri = "https://elsewhere.test/__/auth/handler";
    public static readonly UnknownProvider = "facebook.com";
    public static readonly ApiKeyRef = "secret://key";
    public static readonly Tenant = "tenant-a";
    public static readonly TenantField = "tenantId";
    public static readonly LoginHint = "login_hint";
    public static readonly PromptParam = "prompt";
    public static readonly SelectAccount = "select_account";
    public static readonly RedirectParam = "redirect_uri";
    public static readonly IdTokenParam = "id_token";
    public static readonly CustomParameterField = "customParameter";
    public static readonly InvalidProvider = "INVALID_PROVIDER_ID";
    public static readonly MissingContinueUri = "MISSING_CONTINUE_URI";
    public static readonly InvalidIdpResponse = "INVALID_IDP_RESPONSE";
    public static readonly NeedConfirmation = "NEED_CONFIRMATION";
    public static readonly AlreadyLinked = "FEDERATED_USER_ID_ALREADY_LINKED";
    public static readonly Malformed = "MALFORMED_RESPONSE";
    public static readonly InvalidCredentials = "INVALID_LOGIN_CREDENTIALS";
    public static readonly IllegalInvocation = "Illegal invocation";
    public static readonly CreateAuthUriPath = "accounts:createAuthUri";
    public static readonly SignInWithIdpPath = "accounts:signInWithIdp";
    public static readonly BaseUrl = "https://identitytoolkit.test/v1/";
    public static readonly CannedSessionId = "canned-session";
    public static readonly KeyParam = "key";
    public static readonly Empty = "";
    public static readonly GmailDomain = "gmail.test";
    public static readonly GmailEmail = "person@gmail.test";
    public static readonly CannedUid = "canned-uid";
    public static readonly CannedToken = "canned-token";
    public static readonly StatusOk = 200;

    public static async Make(tenant: string | null = null): Promise<{ platform: FakeIdentityPlatform; rest: FakeIdentityPlatformRest; client: IdentityPlatformRestClient; verifier: IdentityPlatformTokenVerifier }>
    {
        const platform = await FakeIdentityPlatform.Create();
        const rest = new FakeIdentityPlatformRest(platform, FakeIdentityPlatformRest.ApiKey, tenant);
        const client = IdentityPlatformRestClient.For(Fixture.Page(platform, tenant), rest.Fetch);
        const settings = new Map([
            [IdentityPlatformSettingKeys.ProjectId, platform.ProjectId],
            [IdentityPlatformSettingKeys.ApiKeyRef, Fixture.ApiKeyRef],
            [IdentityPlatformSettingKeys.Providers, [IdentityPlatformProvider.Password, IdentityPlatformProvider.Google].join(",")],
        ]);
        if (tenant !== null)
        {
            settings.set(IdentityPlatformSettingKeys.TenantId, tenant);
        }
        const verifier = new IdentityPlatformTokenVerifier(IdentityPlatformSettings.From(settings), new IdentityPlatformKeySet(new FakeIdentityPlatformHttp(platform)));
        return { platform, rest, client, verifier };
    }

    public static Page(platform: FakeIdentityPlatform, tenant: string | null = null): IdentityPlatformPageConfig
    {
        return new IdentityPlatformPageConfig(platform.ProjectId, FakeIdentityPlatformRest.ApiKey, platform.ProjectId, [IdentityPlatformProvider.Password, IdentityPlatformProvider.Google], tenant);
    }

    public static Person(email: string = Fixture.Email): FakeFederatedPerson
    {
        return new FakeFederatedPerson(email, Fixture.Name);
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

    /** A fetch that, like the browser's, refuses to run with a `this` other than the global object. */
    public static StrictFetch(inner: typeof fetch): typeof fetch
    {
        return function (this: unknown, input: string | URL | Request, init?: RequestInit): Promise<Response>
        {
            if (this !== undefined && this !== globalThis)
            {
                throw new TypeError(Fixture.IllegalInvocation);
            }
            return inner(input, init);
        } as typeof fetch;
    }
}

/** An HTTP client answering every post with one canned body, recording what was posted. */
class CannedHttp implements IIdentityPlatformHttp
{
    public readonly Urls: string[] = [];
    public readonly Bodies: unknown[] = [];

    public constructor(private readonly answer: unknown, private readonly status: number = Fixture.StatusOk)
    {
    }

    public async PostJson(url: string, body: unknown): Promise<IdentityPlatformHttpResponse>
    {
        this.Urls.push(url);
        this.Bodies.push(body);
        return new IdentityPlatformHttpResponse(this.status, this.answer);
    }
}

class FederatedSignInTests
{
    public static Register(): void
    {
        test("createAuthUri, the provider's answer, signInWithIdp: the token passes the source as a google.com sign-in", async () =>
        {
            const { rest, client, verifier } = await Fixture.Make();
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            assert.equal(start.ProviderId, IdentityPlatformProvider.Google);
            assert.ok(start.SessionId.length > 0);
            assert.equal(new URL(start.AuthUri).searchParams.get(Fixture.RedirectParam), Fixture.ContinueUri);

            const requestUri = rest.SignInAtProvider(start.AuthUri, Fixture.Person());
            const session = await client.SignInWithIdp(requestUri, start.SessionId);
            assert.equal(session.ProviderId, IdentityPlatformProvider.Google);
            assert.equal(session.Email, Fixture.Email);
            assert.equal(session.EmailVerified, true);
            assert.equal(session.DisplayName, Fixture.Name);
            assert.equal(session.IsNewUser, true);
            assert.ok(session.RefreshToken.length > 0);
            assert.ok(session.ExpiresInSeconds > 0);

            const verification = await verifier.Verify(session.IdToken);
            assert.equal(verification.Rejection, null);
            assert.equal(verification.Token!.Uid, session.Uid);
            assert.equal(verification.Token!.SignInProvider, IdentityPlatformProvider.Google);

            const user = await client.Lookup(session.IdToken);
            assert.deepEqual([...user.Providers], [IdentityPlatformProvider.Google]);
        });

        test("a second Google sign-in reaches the same account, no longer new", async () =>
        {
            const { rest, client } = await Fixture.Make();
            const first = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const firstSession = await client.SignInWithIdp(rest.SignInAtProvider(first.AuthUri, Fixture.Person()), first.SessionId);
            const second = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const secondSession = await client.SignInWithIdp(rest.SignInAtProvider(second.AuthUri, Fixture.Person()), second.SessionId);
            assert.equal(secondSession.Uid, firstSession.Uid);
            assert.equal(secondSession.IsNewUser, false);
        });

        test("Google signs in to the password account of the same email: linked when verified, the password dropped when not", async () =>
        {
            const { rest, client } = await Fixture.Make();
            const verified = await client.SignUp(Fixture.Email, Fixture.Password);
            rest.VerifyEmail(Fixture.Email);
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const session = await client.SignInWithIdp(rest.SignInAtProvider(start.AuthUri, Fixture.Person()), start.SessionId);
            assert.equal(session.Uid, verified.Uid);
            assert.equal(session.IsNewUser, false);
            const user = await client.Lookup(session.IdToken);
            assert.equal(user.EmailVerified, true);
            assert.deepEqual([...user.Providers].sort(), [IdentityPlatformProvider.Google, IdentityPlatformProvider.Password].sort());

            const unverified = await client.SignUp(Fixture.OtherEmail, Fixture.Password);
            const again = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const taken = await client.SignInWithIdp(rest.SignInAtProvider(again.AuthUri, Fixture.Person(Fixture.OtherEmail)), again.SessionId);
            assert.equal(taken.Uid, unverified.Uid);
            assert.deepEqual([...(await client.Lookup(taken.IdToken)).Providers], [IdentityPlatformProvider.Google]);
            assert.equal(await Fixture.Code(client.SignInWithPassword(Fixture.OtherEmail, Fixture.Password)), Fixture.InvalidCredentials);
        });

        test("an existing account whose email domain Google is not authoritative for needs confirmation, unless Google is linked already", async () =>
        {
            const platform = await FakeIdentityPlatform.Create();
            const rest = new FakeIdentityPlatformRest(platform, FakeIdentityPlatformRest.ApiKey, null, [Fixture.GmailDomain]);
            const client = IdentityPlatformRestClient.For(Fixture.Page(platform), rest.Fetch);
            await client.SignUp(Fixture.Email, Fixture.Password);
            rest.VerifyEmail(Fixture.Email);
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const error = await client.SignInWithIdp(rest.SignInAtProvider(start.AuthUri, Fixture.Person()), start.SessionId).catch((e: unknown) => e);
            assert.ok(error instanceof IdentityPlatformRestError);
            assert.equal(error.Code, Fixture.NeedConfirmation);
            assert.equal(error.Status, Fixture.StatusOk);

            const fresh = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const gmail = await client.SignInWithIdp(rest.SignInAtProvider(fresh.AuthUri, Fixture.Person(Fixture.GmailEmail.toUpperCase())), fresh.SessionId);
            assert.equal(gmail.IsNewUser, true);

            const first = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const created = await client.SignInWithIdp(rest.SignInAtProvider(first.AuthUri, Fixture.Person(Fixture.OtherEmail)), first.SessionId);
            assert.equal(created.IsNewUser, true);
            const second = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const linked = await client.SignInWithIdp(rest.SignInAtProvider(second.AuthUri, Fixture.Person(Fixture.OtherEmail)), second.SessionId);
            assert.equal(linked.Uid, created.Uid);
            assert.equal(linked.IsNewUser, false);
        });

        test("custom parameters reach the provider's authorization URL, never over the protocol's own", async () =>
        {
            const { rest, client } = await Fixture.Make();
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri, new Map([[Fixture.LoginHint, Fixture.Email], [Fixture.PromptParam, Fixture.SelectAccount], [Fixture.RedirectParam, Fixture.ElsewhereUri]]));
            const query = new URL(start.AuthUri).searchParams;
            assert.equal(query.get(Fixture.LoginHint), Fixture.Email);
            assert.equal(query.get(Fixture.PromptParam), Fixture.SelectAccount);
            assert.equal(query.get(Fixture.RedirectParam), Fixture.ContinueUri);
            assert.deepEqual(rest.RequestBodies.at(-1)![Fixture.CustomParameterField], { [Fixture.LoginHint]: Fixture.Email, [Fixture.PromptParam]: Fixture.SelectAccount, [Fixture.RedirectParam]: Fixture.ElsewhereUri });
        });

        test("createAuthUri refuses an unknown provider and a missing continue URI", async () =>
        {
            const { client } = await Fixture.Make();
            assert.equal(await Fixture.Code(client.CreateAuthUri(Fixture.UnknownProvider, Fixture.ContinueUri)), Fixture.InvalidProvider);
            assert.equal(await Fixture.Code(client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.Empty)), Fixture.MissingContinueUri);
        });

        test("signInWithIdp refuses another session, another return URL, a forged answer and a replayed one", async () =>
        {
            const { rest, client } = await Fixture.Make();
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const other = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const requestUri = rest.SignInAtProvider(start.AuthUri, Fixture.Person());
            assert.equal(await Fixture.Code(client.SignInWithIdp(requestUri, other.SessionId)), Fixture.InvalidIdpResponse);
            const moved = new URL(Fixture.ElsewhereUri);
            moved.hash = new URL(requestUri).hash;
            assert.equal(await Fixture.Code(client.SignInWithIdp(moved.href, start.SessionId)), Fixture.InvalidIdpResponse);
            const forged = new URL(requestUri);
            const answer = new URLSearchParams(forged.hash.slice(1));
            answer.set(Fixture.IdTokenParam, Fixture.CannedToken);
            forged.hash = answer.toString();
            assert.equal(await Fixture.Code(client.SignInWithIdp(forged.href, start.SessionId)), Fixture.InvalidIdpResponse);
            await client.SignInWithIdp(requestUri, start.SessionId);
            assert.equal(await Fixture.Code(client.SignInWithIdp(requestUri, start.SessionId)), Fixture.InvalidIdpResponse);
        });

        test("an Identity Platform tenant id travels in the federated requests too", async () =>
        {
            const { rest, client, verifier } = await Fixture.Make(Fixture.Tenant);
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const session = await client.SignInWithIdp(rest.SignInAtProvider(start.AuthUri, Fixture.Person(Fixture.OtherEmail)), start.SessionId);
            assert.ok(rest.RequestBodies.every(body => body[Fixture.TenantField] === Fixture.Tenant));
            assert.equal((await verifier.Verify(session.IdToken)).Token!.TenantId, Fixture.Tenant);
        });

        test("a signInWithIdp answer that needs confirmation, names an error or lacks the token is an error", async () =>
        {
            const page = Fixture.Page(await FakeIdentityPlatform.Create());
            const confirm = IdentityPlatformRestClient.WithHttp(page, new CannedHttp({ needConfirmation: true, email: Fixture.Email, providerId: IdentityPlatformProvider.Google }));
            assert.equal(await Fixture.Code(confirm.SignInWithIdp(Fixture.ContinueUri, Fixture.CannedSessionId)), Fixture.NeedConfirmation);
            const named = IdentityPlatformRestClient.WithHttp(page, new CannedHttp({ errorMessage: Fixture.AlreadyLinked }));
            const error = await named.SignInWithIdp(Fixture.ContinueUri, Fixture.CannedSessionId).catch((e: unknown) => e);
            assert.ok(error instanceof IdentityPlatformRestError);
            assert.equal(error.Code, Fixture.AlreadyLinked);
            assert.equal(error.Status, Fixture.StatusOk);
            const empty = IdentityPlatformRestClient.WithHttp(page, new CannedHttp({ providerId: IdentityPlatformProvider.Google }));
            assert.equal(await Fixture.Code(empty.SignInWithIdp(Fixture.ContinueUri, Fixture.CannedSessionId)), Fixture.Malformed);
            const noUri = IdentityPlatformRestClient.WithHttp(page, new CannedHttp({ sessionId: Fixture.CannedSessionId }));
            assert.equal(await Fixture.Code(noUri.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri)), Fixture.Malformed);
        });

        test("an injected HTTP client carries every call: the key in the URL, the fields as the JSON body", async () =>
        {
            const http = new CannedHttp({ authUri: Fixture.ContinueUri, sessionId: Fixture.CannedSessionId, providerId: IdentityPlatformProvider.Google });
            const client = new IdentityPlatformRestClient(FakeIdentityPlatformRest.ApiKey, null, http, Fixture.BaseUrl);
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            assert.equal(start.SessionId, Fixture.CannedSessionId);
            const url = new URL(http.Urls[0]!);
            assert.equal(url.origin + url.pathname, Fixture.BaseUrl + Fixture.CreateAuthUriPath);
            assert.equal(url.searchParams.get(Fixture.KeyParam), FakeIdentityPlatformRest.ApiKey);
            assert.deepEqual(http.Bodies[0], { providerId: IdentityPlatformProvider.Google, continueUri: Fixture.ContinueUri });

            const idp = new CannedHttp({ localId: Fixture.CannedUid, idToken: Fixture.CannedToken, providerId: IdentityPlatformProvider.Google });
            await new IdentityPlatformRestClient(FakeIdentityPlatformRest.ApiKey, null, idp, Fixture.BaseUrl).SignInWithIdp(Fixture.ContinueUri, Fixture.CannedSessionId);
            assert.ok(idp.Urls[0]!.startsWith(Fixture.BaseUrl + Fixture.SignInWithIdpPath));
            assert.deepEqual(idp.Bodies[0], { requestUri: Fixture.ContinueUri, sessionId: Fixture.CannedSessionId, returnSecureToken: true, returnIdpCredential: true });
        });

        test("a browser-style fetch passed unbound still works: it is never called as a method of the client", async () =>
        {
            const { platform, rest } = await Fixture.Make();
            const client = IdentityPlatformRestClient.For(Fixture.Page(platform), Fixture.StrictFetch(rest.Fetch));
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            const session = await client.SignInWithIdp(rest.SignInAtProvider(start.AuthUri, Fixture.Person()), start.SessionId);
            assert.ok(session.IdToken.length > 0);
            const signedUp = await client.SignUp(Fixture.OtherEmail, Fixture.Password);
            assert.ok(signedUp.IdToken.length > 0);
        });

        test("the constructor takes a fetch as well as an HTTP client (a fetch passed unbound too)", async () =>
        {
            const { rest } = await Fixture.Make();
            const client = new IdentityPlatformRestClient(FakeIdentityPlatformRest.ApiKey, null, Fixture.StrictFetch(rest.Fetch));
            const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
            assert.ok(start.SessionId.length > 0);
        });

        test("the fetch HTTP client reads the global fetch at call time when given none", async () =>
        {
            const { rest } = await Fixture.Make();
            const original = globalThis.fetch;
            globalThis.fetch = Fixture.StrictFetch(rest.Fetch);
            try
            {
                const http = new FetchIdentityPlatformHttp();
                const client = new IdentityPlatformRestClient(FakeIdentityPlatformRest.ApiKey, null, http);
                const start = await client.CreateAuthUri(IdentityPlatformProvider.Google, Fixture.ContinueUri);
                assert.ok(start.SessionId.length > 0);
            }
            finally
            {
                globalThis.fetch = original;
            }
        });
    }
}

FederatedSignInTests.Register();
