import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import type { JWK } from "jose";
import type { IHttpClient } from "../../http/http-client.js";
import { FakeOidcIdp } from "../../testing/fake-oidc-idp.js";
import type { MintOptions } from "../../testing/fake-oidc-idp.js";
import { TlsTestRealm } from "../../testing/tls-test-realm.js";
import { RealmTokenVerifier } from "../realm-token-verifier.js";
import type { RealmTokenVerifierOptions } from "../realm-token-verifier-options.js";
import { TokenVerifierUnavailableError } from "../token-verifier-unavailable-error.js";

/** The realm's discovery document and a key set the test can rotate; counts what is fetched. */
class RealmHttp implements IHttpClient
{
    private static readonly WellKnown = "/.well-known/openid-configuration";

    public Keys: JWK[];
    public Discovery: Record<string, unknown>;
    public Down = false;
    public readonly Fetched: string[] = [];

    public constructor(public readonly Idp: FakeOidcIdp)
    {
        this.Keys = Idp.Jwks().keys;
        this.Discovery = Idp.DiscoveryDocument() as Record<string, unknown>;
    }

    public async GetJson(url: string): Promise<unknown>
    {
        this.Fetched.push(url);
        if (this.Down)
        {
            throw new Error("unreachable");
        }
        if (url.endsWith(RealmHttp.WellKnown))
        {
            return this.Discovery;
        }
        if (url === this.Idp.JwksUri)
        {
            return { keys: this.Keys };
        }
        throw new Error("unknown url");
    }

    public async PostForm(): Promise<unknown>
    {
        throw new Error("no posts");
    }

    public Count(url: string): number
    {
        return this.Fetched.filter(u => u === url || (url.endsWith(RealmHttp.WellKnown) && u.endsWith(RealmHttp.WellKnown))).length;
    }
}

class Clock
{
    public Ms = Date.now();

    public readonly Now = (): Date => new Date(this.Ms);

    public Advance(seconds: number): void
    {
        this.Ms += seconds * 1000;
    }
}

class Fixture
{
    public static readonly Issuer = "https://login.test/realms/central";
    public static readonly Audience = "pragmatic-ledger";

    private constructor(public readonly Idp: FakeOidcIdp, public readonly Http: RealmHttp, public readonly Clock: Clock)
    {
    }

    public static async Create(issuer: string = Fixture.Issuer): Promise<Fixture>
    {
        const idp = await FakeOidcIdp.Create(issuer);
        return new Fixture(idp, new RealmHttp(idp), new Clock());
    }

    public Verifier(options: Partial<RealmTokenVerifierOptions> = {}): RealmTokenVerifier
    {
        return new RealmTokenVerifier({ Issuer: this.Idp.Issuer, Audience: Fixture.Audience, Http: this.Http, Now: this.Clock.Now, ...options });
    }

    public Token(claims: Record<string, unknown> = {}, opts: MintOptions = {}): Promise<string>
    {
        return this.Idp.MintIdToken({ sub: "u1", aud: Fixture.Audience, email: "u1@acme.com", email_verified: true, ...claims }, opts);
    }
}

test("a valid token answers its typed principal: issuer, subject, email, verified flag, realm roles and claims", async () =>
{
    const f = await Fixture.Create();
    const principal = await f.Verifier().Verify(await f.Token({ roles: ["admin", 7], app_roles: { "pragmatic-ledger": ["staff"], "Bad Name": ["x"] }, name: "Una" }));
    assert.ok(principal);
    assert.equal(principal.Issuer, Fixture.Issuer);
    assert.equal(principal.Subject, "u1");
    assert.equal(principal.Email, "u1@acme.com");
    assert.equal(principal.EmailVerified, true);
    assert.deepEqual(principal.Roles.TenantRoles, ["admin"]);
    assert.deepEqual(principal.Roles.RolesOf("pragmatic-ledger"), ["staff"]);
    assert.deepEqual([...principal.Roles.ApplicationRoles.keys()], ["pragmatic-ledger"]);
    assert.deepEqual(principal.Audience, [Fixture.Audience]);
    assert.equal(principal.Claims.name, "Una");
    assert.ok(Object.isFrozen(principal));
});

test("without email claims the principal has none and is not verified; roles are empty", async () =>
{
    const f = await Fixture.Create();
    const principal = await f.Verifier().Verify(await f.Token({ email: undefined, email_verified: undefined }));
    assert.ok(principal);
    assert.equal(principal.Email, undefined);
    assert.equal(principal.EmailVerified, false);
    assert.ok(principal.Roles.IsEmpty);
    assert.equal((await f.Verifier().Verify(await f.Token({ email_verified: "true" })))?.EmailVerified, false);
});

test("audience: a token for someone else is refused; any one of several configured audiences is accepted", async () =>
{
    const f = await Fixture.Create();
    assert.equal(await f.Verifier().Verify(await f.Token({ aud: "someone-else" })), undefined);
    const many = f.Verifier({ Audience: ["pragmatic-cabinet", Fixture.Audience] });
    assert.equal((await many.Verify(await f.Token({ aud: ["x", Fixture.Audience] })))?.Subject, "u1");
});

test("authorized party: when configured, azp must be present and one of them", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier({ AuthorizedParties: ["cabinet-web"] });
    assert.equal((await verifier.Verify(await f.Token({ azp: "cabinet-web" })))?.AuthorizedParty, "cabinet-web");
    assert.equal(await verifier.Verify(await f.Token({ azp: "other" })), undefined);
    assert.equal(await verifier.Verify(await f.Token()), undefined);
    assert.equal((await f.Verifier().Verify(await f.Token({ azp: "anything" })))?.AuthorizedParty, "anything");
});

test("issuer: a token naming another issuer is refused, and so is one signed by another key under the same kid", async () =>
{
    const f = await Fixture.Create();
    assert.equal(await f.Verifier().Verify(await f.Token({}, { issuer: "https://evil.test" })), undefined);
    const forger = await FakeOidcIdp.Create(Fixture.Issuer);
    assert.equal(await f.Verifier().Verify(await forger.MintIdToken({ sub: "u1", aud: Fixture.Audience })), undefined);
});

test("malformed, unsigned and symmetric tokens are refused", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier();
    assert.equal(await verifier.Verify(""), undefined);
    assert.equal(await verifier.Verify("not-a-token"), undefined);
    assert.equal(await verifier.Verify("x".repeat(20_000)), undefined);
    assert.equal(await verifier.Verify(f.Idp.MintRawUnsigned({ iss: Fixture.Issuer, sub: "u1", aud: Fixture.Audience, exp: 9999999999, iat: 1 })), undefined);
    const hs = await new SignJWT({ sub: "u1", aud: Fixture.Audience }).setProtectedHeader({ alg: "HS256", kid: "test-key-1" }).setIssuer(Fixture.Issuer).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode("k".repeat(32)));
    assert.equal(await verifier.Verify(hs), undefined);
});

test("exp, nbf and iat are checked with the clock skew (60 s by default, configurable)", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier();
    assert.ok(await verifier.Verify(await f.Token({}, { expSecondsFromNow: -30 })));
    assert.equal(await verifier.Verify(await f.Token({}, { expSecondsFromNow: -90 })), undefined);
    assert.equal(await f.Verifier({ ClockSkewSeconds: 10 }).Verify(await f.Token({}, { expSecondsFromNow: -30 })), undefined);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(await verifier.Verify(await f.Token({ nbf: now + 30 })));
    assert.equal(await verifier.Verify(await f.Token({ nbf: now + 120 })), undefined);
    assert.ok(await verifier.Verify(await f.Token({}, { iatSecondsFromNow: 30 })));
    assert.equal(await verifier.Verify(await f.Token({}, { iatSecondsFromNow: 120 })), undefined);
    assert.equal(await verifier.Verify(await f.Token({}, { iatSecondsFromNow: null })), undefined);
});

test("subject is required and non-empty; extra required claims and the email requirements are honoured", async () =>
{
    const f = await Fixture.Create();
    assert.equal(await f.Verifier().Verify(await f.Token({ sub: "" })), undefined);
    assert.equal(await f.Verifier().Verify(await f.Token({ sub: 42 })), undefined);
    assert.equal(await f.Verifier({ RequiredClaims: ["tenant"] }).Verify(await f.Token()), undefined);
    assert.ok(await f.Verifier({ RequiredClaims: ["tenant"] }).Verify(await f.Token({ tenant: "t1" })));
    assert.equal(await f.Verifier({ RequireEmail: true }).Verify(await f.Token({ email: undefined })), undefined);
    assert.equal(await f.Verifier({ RequireEmail: true }).Verify(await f.Token({ email: 5 })), undefined);
    assert.ok(await f.Verifier({ RequireEmail: true }).Verify(await f.Token({ email_verified: false })));
    assert.equal(await f.Verifier({ RequireVerifiedEmail: true }).Verify(await f.Token({ email_verified: false })), undefined);
    assert.equal(await f.Verifier({ RequireVerifiedEmail: true }).Verify(await f.Token({ email: undefined })), undefined);
    assert.ok(await f.Verifier({ RequireVerifiedEmail: true }).Verify(await f.Token()));
});

test("discovery and keys are fetched once and cached; the default discovery URL is the issuer's well-known document", async () =>
{
    const f = await Fixture.Create(Fixture.Issuer + "/");
    const verifier = f.Verifier();
    assert.ok(await verifier.Verify(await f.Token()));
    assert.ok(await verifier.Verify(await f.Token()));
    assert.deepEqual([...new Set(f.Http.Fetched)], [Fixture.Issuer + "/.well-known/openid-configuration", f.Idp.JwksUri]);
    assert.equal(f.Http.Fetched.length, 2);
});

test("keys are refetched when older than their lifetime, discovery when older than its own", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier({ KeysTtlSeconds: 600, DiscoveryTtlSeconds: 1200 });
    assert.ok(await verifier.Verify(await f.Token({}, { expSecondsFromNow: 3600 })));
    f.Clock.Advance(601);
    assert.ok(await verifier.Verify(await f.Token({}, { expSecondsFromNow: 3600 })));
    assert.equal(f.Http.Count(f.Idp.JwksUri), 2);
    assert.equal(f.Http.Count(f.Idp.DiscoveryUrl), 1);
    f.Clock.Advance(601);
    assert.ok(await verifier.Verify(await f.Token({}, { expSecondsFromNow: 3600 })));
    assert.equal(f.Http.Count(f.Idp.DiscoveryUrl), 2);
});

test("key rotation: an unknown kid refetches the keys at once, then at most once per refresh interval", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier({ MinKeyRefreshSeconds: 60 });
    assert.ok(await verifier.Verify(await f.Token()));
    const rotated = await FakeOidcIdp.Create(Fixture.Issuer, "test-key-2");
    f.Http.Keys = [...f.Http.Keys, ...rotated.Jwks().keys];
    assert.equal((await verifier.Verify(await rotated.MintIdToken({ sub: "u2", aud: Fixture.Audience })))?.Subject, "u2");
    assert.equal(f.Http.Count(f.Idp.JwksUri), 2);

    const next = await FakeOidcIdp.Create(Fixture.Issuer, "test-key-3");
    f.Http.Keys = next.Jwks().keys;
    assert.equal(await verifier.Verify(await next.MintIdToken({ sub: "u3", aud: Fixture.Audience })), undefined);
    assert.equal(f.Http.Count(f.Idp.JwksUri), 2);
    f.Clock.Advance(61);
    assert.equal((await verifier.Verify(await next.MintIdToken({ sub: "u3", aud: Fixture.Audience })))?.Subject, "u3");
    assert.equal(f.Http.Count(f.Idp.JwksUri), 3);
    assert.equal(await verifier.Verify(await f.Token()), undefined);
});

test("it throws when it cannot decide (discovery or keys unreachable), and a failed fetch is not cached", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier();
    const token = await f.Token();
    f.Http.Down = true;
    await assert.rejects(verifier.Verify(token), TokenVerifierUnavailableError);
    f.Http.Down = false;
    assert.ok(await verifier.Verify(token));
});

test("a discovery document for another issuer, without keys or with insecure keys makes it unavailable", async () =>
{
    for (const discovery of [{ issuer: "https://other.test" }, { jwks_uri: undefined }, { jwks_uri: "http://login.test/keys" }])
    {
        const f = await Fixture.Create();
        f.Http.Discovery = { ...f.Http.Discovery, ...discovery };
        await assert.rejects(f.Verifier().Verify(await f.Token()), TokenVerifierUnavailableError);
    }
});

test("options are checked: an issuer, an audience, https discovery", async () =>
{
    const f = await Fixture.Create();
    assert.throws(() => f.Verifier({ Issuer: "" }));
    assert.throws(() => f.Verifier({ Audience: [] }));
    assert.throws(() => f.Verifier({ Audience: "" }));
    assert.throws(() => f.Verifier({ DiscoveryUrl: "http://login.test/.well-known/openid-configuration" }));
});

test("a realm on a private CA: verified through its CA bundle file, unavailable without it", async () =>
{
    let idp!: FakeOidcIdp;
    const routes = new Map<string, () => unknown>([
        ["/.well-known/openid-configuration", () => idp.DiscoveryDocument()],
        ["/jwks", () => idp.Jwks()],
    ]);
    const realm = await TlsTestRealm.Start(routes);
    try
    {
        idp = await FakeOidcIdp.Create(realm.Origin);
        const token = await idp.MintIdToken({ sub: "u1", aud: Fixture.Audience });
        const trusted = new RealmTokenVerifier({ Issuer: realm.Origin, Audience: Fixture.Audience, CaBundleFile: TlsTestRealm.CaFile });
        assert.equal((await trusted.Verify(token))?.Subject, "u1");
        const untrusted = new RealmTokenVerifier({ Issuer: realm.Origin, Audience: Fixture.Audience });
        await assert.rejects(untrusted.Verify(token), TokenVerifierUnavailableError);
    }
    finally
    {
        await realm.Stop();
    }
});

test("type: when configured the header's typ must match (an ID token is not an access token); absent it is not checked", async () =>
{
    const f = await Fixture.Create();
    const verifier = f.Verifier({ Type: "at+jwt" });
    assert.equal((await verifier.Verify(await f.Token({}, { typ: "at+jwt" })))?.Subject, "u1");
    assert.equal((await verifier.Verify(await f.Token({}, { typ: "application/at+jwt" })))?.Subject, "u1", "RFC 8725 3.11: the application/ prefix may be left out");
    assert.equal(await verifier.Verify(await f.Token()), undefined);
    assert.equal(await verifier.Verify(await f.Token({}, { typ: "JWT" })), undefined);
    assert.equal((await f.Verifier().Verify(await f.Token({}, { typ: "JWT" })))?.Subject, "u1");
    assert.equal(await verifier.Verify(await f.Token({ aud: "someone-else" }, { typ: "at+jwt" })), undefined, "the type does not stand in for the audience");
});
