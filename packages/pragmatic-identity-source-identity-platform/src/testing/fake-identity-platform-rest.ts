import { decodeJwt } from "jose";
import { IdentityPlatformProvider } from "../client/identity-platform-provider.js";
import type { FakeIdentityPlatform } from "./fake-identity-platform.js";

class FakeAccount
{
    public Verified = false;
    public readonly Providers = new Set<string>();

    public constructor(
        public readonly Uid: string,
        public readonly Email: string,
        public Password: string | null,
        public DisplayName: string | null)
    {
        if (Password !== null)
        {
            this.Providers.add(IdentityPlatformProvider.Password);
        }
    }
}

/** A createAuthUri in flight: its session, where the provider returns the browser, and the provider's answer once given. */
class FakePendingAuth
{
    public ProviderToken: string | null = null;
    public Person: FakeFederatedPerson | null = null;

    public constructor(
        public readonly SessionId: string,
        public readonly ProviderId: string,
        public readonly ContinueUri: string)
    {
    }
}

/** The person who signs in at the upstream provider (Google) during a federated round trip. */
export class FakeFederatedPerson
{
    public constructor(public readonly Email: string, public readonly Name: string | null = null)
    {
    }
}

/** An out-of-band email the fake "sent" (verification or password reset). */
export class FakeOobEmail
{
    public constructor(public readonly RequestType: string, public readonly Email: string)
    {
    }
}

/**
 * The identitytoolkit v1 REST endpoints the login page drives (accounts:signUp, :signInWithPassword, :sendOobCode,
 * :lookup, :createAuthUri, :signInWithIdp), in memory, as a `fetch` implementation. Tokens are real ID tokens minted
 * by the FakeIdentityPlatform, so a page flow against this fake ends in a token the source verifies. `VerifyEmail`
 * stands in for the person clicking the verification link, `SignInAtProvider` for the person signing in at Google
 * (who, as live, answers `response_type=id_token` in the return URL's fragment, so the page passes its whole href).
 * A Google sign-in reaches the account of the same email. Google is authoritative only for the email domains it owns
 * (Gmail, Google Workspace: `trustedEmailDomains`, default every domain): there the account is linked when its email
 * is verified, otherwise taken over (its password dropped); for another domain an existing account answers
 * `needConfirmation` (the person must sign in with the existing method first), as Identity Platform does.
 */
export class FakeIdentityPlatformRest
{
    public static readonly ApiKey = "fake-browser-api-key";

    private static readonly KeyParam = "key";
    private static readonly Empty = "";
    private static readonly SignUpPath = "accounts:signUp";
    private static readonly SignInPath = "accounts:signInWithPassword";
    private static readonly SendOobCodePath = "accounts:sendOobCode";
    private static readonly LookupPath = "accounts:lookup";
    private static readonly CreateAuthUriPath = "accounts:createAuthUri";
    private static readonly SignInWithIdpPath = "accounts:signInWithIdp";
    private static readonly ProviderAuthorizeUrl = "https://accounts.google.test/o/oauth2/auth";
    private static readonly ProviderClientId = "fake-oauth-client";
    private static readonly ResponseTypeParam = "response_type";
    private static readonly IdTokenResponseType = "id_token";
    private static readonly ClientIdParam = "client_id";
    private static readonly RedirectUriParam = "redirect_uri";
    private static readonly StateParam = "state";
    private static readonly ScopeParam = "scope";
    private static readonly NonceParam = "nonce";
    private static readonly IdTokenParam = "id_token";
    private static readonly ProviderScope = "openid https://www.googleapis.com/auth/userinfo.email";
    private static readonly SessionPrefix = "fake-session-";
    private static readonly StatePrefix = "fake-state-";
    private static readonly NoncePrefix = "fake-nonce-";
    private static readonly ProviderTokenPrefix = "fake-google-id-token-";
    private static readonly AuthUriKind = "identitytoolkit#CreateAuthUriResponse";
    private static readonly IdpKind = "identitytoolkit#VerifyAssertionResponse";
    private static readonly InvalidProviderId = "INVALID_PROVIDER_ID : Provider Id is not supported.";
    private static readonly MissingContinueUri = "MISSING_CONTINUE_URI";
    private static readonly InvalidIdpResponse = "INVALID_IDP_RESPONSE : the provider's answer does not match a pending sign-in";
    private static readonly UnknownAuthUriMessage = "FakeIdentityPlatformRest: the URL is not an authorization URL the fake gave";
    private static readonly VerifyEmail = "VERIFY_EMAIL";
    private static readonly PasswordReset = "PASSWORD_RESET";
    private static readonly EmailExists = "EMAIL_EXISTS";
    private static readonly WeakPassword = "WEAK_PASSWORD : Password should be at least 6 characters";
    private static readonly InvalidCredentials = "INVALID_LOGIN_CREDENTIALS";
    private static readonly InvalidIdToken = "INVALID_ID_TOKEN";
    private static readonly InvalidEmail = "INVALID_EMAIL";
    private static readonly MissingPassword = "MISSING_PASSWORD";
    private static readonly ApiKeyInvalid = "API key not valid. Please pass a valid API key.";
    private static readonly NotFound = "NOT_FOUND";
    private static readonly WrongTenant = "TENANT_ID_MISMATCH_WITH_CURRENT_TENANT";
    private static readonly MinPasswordLength = 6;
    private static readonly UidPrefix = "fake-uid-";
    private static readonly RefreshPrefix = "fake-refresh-";
    private static readonly ExpiresIn = "3600";
    private static readonly IdTokenKind = "identitytoolkit#SignupNewUserResponse";
    private static readonly ContentType = "application/json";
    private static readonly ContentTypeHeader = "content-type";
    private static readonly EmailAt = "@";
    private static readonly StatusOk = 200;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusNotFound = 404;

    public readonly SentEmails: FakeOobEmail[] = [];
    public readonly RequestBodies: Array<Record<string, unknown>> = [];

    private readonly accounts = new Map<string, FakeAccount>();
    private readonly pending = new Map<string, FakePendingAuth>();
    private readonly federatedProviders: ReadonlySet<string> = new Set<string>([IdentityPlatformProvider.Google]);
    private uidCounter = 0;
    private authCounter = 0;

    /** `trustedEmailDomains`: the email domains Google is authoritative for; null: every domain. */
    public constructor(
        private readonly platform: FakeIdentityPlatform,
        private readonly apiKey: string = FakeIdentityPlatformRest.ApiKey,
        private readonly tenantId: string | null = null,
        private readonly trustedEmailDomains: readonly string[] | null = null)
    {
    }

    /** A `fetch` the REST client can take. */
    public get Fetch(): typeof fetch
    {
        return ((input: string | URL | Request, init?: RequestInit) => this.Handle(input, init)) as typeof fetch;
    }

    /** The person clicked the verification link. */
    public VerifyEmail(email: string): void
    {
        const account = this.accounts.get(email);
        if (account !== undefined)
        {
            account.Verified = true;
        }
    }

    /**
     * The person signed in at the provider: given the authorization URL a createAuthUri answered, the URL the provider
     * sends the browser back to (the continue URI with state and the provider's ID token in the fragment), which the
     * page passes, whole, to signInWithIdp.
     */
    public SignInAtProvider(authUri: string, person: FakeFederatedPerson): string
    {
        const F = FakeIdentityPlatformRest;
        const state = new URL(authUri).searchParams.get(F.StateParam) ?? F.Empty;
        const auth = this.pending.get(state);
        if (auth === undefined)
        {
            throw new Error(F.UnknownAuthUriMessage);
        }
        this.authCounter++;
        auth.ProviderToken = F.ProviderTokenPrefix + this.authCounter;
        auth.Person = person;
        const back = new URL(auth.ContinueUri);
        back.hash = new URLSearchParams([[F.StateParam, state], [F.IdTokenParam, auth.ProviderToken]]).toString();
        return back.href;
    }

    private async Handle(input: string | URL | Request, init?: RequestInit): Promise<Response>
    {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.searchParams.get(FakeIdentityPlatformRest.KeyParam) !== this.apiKey)
        {
            return this.Error(FakeIdentityPlatformRest.ApiKeyInvalid);
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        this.RequestBodies.push(body);
        if (this.tenantId !== null && body.tenantId !== this.tenantId)
        {
            return this.Error(FakeIdentityPlatformRest.WrongTenant);
        }
        const path = url.pathname;
        if (path.endsWith(FakeIdentityPlatformRest.SignUpPath))
        {
            return this.SignUp(body);
        }
        if (path.endsWith(FakeIdentityPlatformRest.SignInPath))
        {
            return this.SignIn(body);
        }
        if (path.endsWith(FakeIdentityPlatformRest.SendOobCodePath))
        {
            return this.SendOobCode(body);
        }
        if (path.endsWith(FakeIdentityPlatformRest.LookupPath))
        {
            return this.Lookup(body);
        }
        if (path.endsWith(FakeIdentityPlatformRest.CreateAuthUriPath))
        {
            return this.CreateAuthUri(body);
        }
        if (path.endsWith(FakeIdentityPlatformRest.SignInWithIdpPath))
        {
            return this.SignInWithIdp(body);
        }
        return new Response(FakeIdentityPlatformRest.NotFound, { status: FakeIdentityPlatformRest.StatusNotFound });
    }

    private async SignUp(body: Record<string, unknown>): Promise<Response>
    {
        const email = String(body.email ?? FakeIdentityPlatformRest.Empty);
        const password = String(body.password ?? FakeIdentityPlatformRest.Empty);
        if (!email.includes(FakeIdentityPlatformRest.EmailAt))
        {
            return this.Error(FakeIdentityPlatformRest.InvalidEmail);
        }
        if (password === FakeIdentityPlatformRest.Empty)
        {
            return this.Error(FakeIdentityPlatformRest.MissingPassword);
        }
        if (this.accounts.has(email))
        {
            return this.Error(FakeIdentityPlatformRest.EmailExists);
        }
        if (password.length < FakeIdentityPlatformRest.MinPasswordLength)
        {
            return this.Error(FakeIdentityPlatformRest.WeakPassword);
        }
        this.uidCounter++;
        const account = new FakeAccount(FakeIdentityPlatformRest.UidPrefix + this.uidCounter, email, password, null);
        this.accounts.set(email, account);
        return this.SessionResponse(account);
    }

    private async SignIn(body: Record<string, unknown>): Promise<Response>
    {
        const account = this.accounts.get(String(body.email ?? FakeIdentityPlatformRest.Empty));
        if (account === undefined || account.Password === null || account.Password !== String(body.password ?? FakeIdentityPlatformRest.Empty))
        {
            return this.Error(FakeIdentityPlatformRest.InvalidCredentials);
        }
        return this.SessionResponse(account);
    }

    private async SendOobCode(body: Record<string, unknown>): Promise<Response>
    {
        const requestType = String(body.requestType ?? FakeIdentityPlatformRest.Empty);
        if (requestType === FakeIdentityPlatformRest.VerifyEmail)
        {
            const account = this.AccountOf(body.idToken);
            if (account === null)
            {
                return this.Error(FakeIdentityPlatformRest.InvalidIdToken);
            }
            this.SentEmails.push(new FakeOobEmail(requestType, account.Email));
            return this.Ok({ email: account.Email });
        }
        if (requestType === FakeIdentityPlatformRest.PasswordReset)
        {
            const email = String(body.email ?? FakeIdentityPlatformRest.Empty);
            // Like Identity Platform with email enumeration protection: the same answer whether or not the account exists.
            if (this.accounts.has(email))
            {
                this.SentEmails.push(new FakeOobEmail(requestType, email));
            }
            return this.Ok({ email });
        }
        return this.Error(FakeIdentityPlatformRest.NotFound);
    }

    private async Lookup(body: Record<string, unknown>): Promise<Response>
    {
        const account = this.AccountOf(body.idToken);
        if (account === null)
        {
            return this.Error(FakeIdentityPlatformRest.InvalidIdToken);
        }
        const user: Record<string, unknown> = {
            localId: account.Uid,
            email: account.Email,
            emailVerified: account.Verified,
            providerUserInfo: [...account.Providers].map(providerId => ({ providerId, email: account.Email })),
        };
        if (account.DisplayName !== null)
        {
            user.displayName = account.DisplayName;
        }
        return this.Ok({ users: [user] });
    }

    private async CreateAuthUri(body: Record<string, unknown>): Promise<Response>
    {
        const F = FakeIdentityPlatformRest;
        const providerId = String(body.providerId ?? F.Empty);
        if (!this.federatedProviders.has(providerId))
        {
            return this.Error(F.InvalidProviderId);
        }
        const continueUri = String(body.continueUri ?? F.Empty);
        if (continueUri === F.Empty)
        {
            return this.Error(F.MissingContinueUri);
        }
        this.authCounter++;
        const state = F.StatePrefix + this.authCounter;
        const auth = new FakePendingAuth(F.SessionPrefix + this.authCounter, providerId, continueUri);
        this.pending.set(state, auth);
        const authUri = new URL(F.ProviderAuthorizeUrl);
        authUri.searchParams.set(F.ResponseTypeParam, F.IdTokenResponseType);
        authUri.searchParams.set(F.ClientIdParam, F.ProviderClientId);
        authUri.searchParams.set(F.RedirectUriParam, continueUri);
        authUri.searchParams.set(F.StateParam, state);
        authUri.searchParams.set(F.ScopeParam, F.ProviderScope);
        authUri.searchParams.set(F.NonceParam, F.NoncePrefix + this.authCounter);
        const custom = body.customParameter as Record<string, unknown> | undefined;
        for (const [name, value] of Object.entries(custom ?? {}))
        {
            // The protocol's own parameters are not the caller's to set.
            if (!authUri.searchParams.has(name))
            {
                authUri.searchParams.set(name, String(value));
            }
        }
        return this.Ok({ kind: F.AuthUriKind, authUri: authUri.href, providerId, sessionId: auth.SessionId });
    }

    private async SignInWithIdp(body: Record<string, unknown>): Promise<Response>
    {
        const F = FakeIdentityPlatformRest;
        const requestUri = URL.parse(String(body.requestUri ?? F.Empty));
        const answer = new URLSearchParams(requestUri?.hash.slice(1) ?? F.Empty);
        const state = answer.get(F.StateParam) ?? F.Empty;
        const auth = this.pending.get(state);
        if (requestUri === null || auth === undefined || auth.ProviderToken === null || auth.Person === null
            || auth.SessionId !== body.sessionId
            || !F.SameEndpoint(requestUri, new URL(auth.ContinueUri))
            || answer.get(F.IdTokenParam) !== auth.ProviderToken)
        {
            return this.Error(F.InvalidIdpResponse);
        }
        this.pending.delete(state);
        const person = auth.Person;
        const existing = this.accounts.get(person.Email);
        if (existing !== undefined && !existing.Providers.has(auth.ProviderId) && !this.Trusted(person.Email))
        {
            return this.Ok({ kind: F.IdpKind, providerId: auth.ProviderId, email: person.Email, needConfirmation: true });
        }
        const account = this.FederatedAccount(person, auth.ProviderId);
        const idToken = await this.platform.MintIdToken({
            Uid: account.Value.Uid,
            Email: account.Value.Email,
            EmailVerified: true,
            Name: account.Value.DisplayName ?? undefined,
            SignInProvider: auth.ProviderId,
            Tenant: this.tenantId ?? undefined,
        });
        const session: Record<string, unknown> = {
            kind: F.IdpKind,
            providerId: auth.ProviderId,
            localId: account.Value.Uid,
            email: account.Value.Email,
            emailVerified: true,
            idToken,
            refreshToken: F.RefreshPrefix + account.Value.Uid,
            expiresIn: F.ExpiresIn,
        };
        if (account.Value.DisplayName !== null)
        {
            session.displayName = account.Value.DisplayName;
        }
        if (account.Created)
        {
            session.isNewUser = true;
        }
        return this.Ok(session);
    }

    private Trusted(email: string): boolean
    {
        const domain = email.slice(email.lastIndexOf(FakeIdentityPlatformRest.EmailAt) + 1).toLowerCase();
        return this.trustedEmailDomains === null || this.trustedEmailDomains.some(trusted => trusted.toLowerCase() === domain);
    }

    private static SameEndpoint(a: URL, b: URL): boolean
    {
        return a.origin === b.origin && a.pathname === b.pathname;
    }

    /** The account a trusted provider signs in to: the one of the same email (linked, or taken over when unverified) or a new one. */
    private FederatedAccount(person: FakeFederatedPerson, providerId: string): { Value: FakeAccount; Created: boolean }
    {
        let account = this.accounts.get(person.Email);
        const created = account === undefined;
        if (account === undefined)
        {
            this.uidCounter++;
            account = new FakeAccount(FakeIdentityPlatformRest.UidPrefix + this.uidCounter, person.Email, null, person.Name);
            this.accounts.set(person.Email, account);
        }
        else if (!account.Verified)
        {
            account.Password = null;
            account.Providers.delete(IdentityPlatformProvider.Password);
        }
        account.Verified = true;
        account.Providers.add(providerId);
        account.DisplayName ??= person.Name;
        return { Value: account, Created: created };
    }

    private AccountOf(idToken: unknown): FakeAccount | null
    {
        if (typeof idToken !== "string")
        {
            return null;
        }
        try
        {
            const uid = decodeJwt(idToken).sub;
            return [...this.accounts.values()].find(account => account.Uid === uid) ?? null;
        }
        catch
        {
            return null;
        }
    }

    private async SessionResponse(account: FakeAccount): Promise<Response>
    {
        const idToken = await this.platform.MintIdToken({
            Uid: account.Uid,
            Email: account.Email,
            EmailVerified: account.Verified,
            Tenant: this.tenantId ?? undefined,
        });
        return this.Ok({
            kind: FakeIdentityPlatformRest.IdTokenKind,
            idToken,
            refreshToken: FakeIdentityPlatformRest.RefreshPrefix + account.Uid,
            expiresIn: FakeIdentityPlatformRest.ExpiresIn,
            localId: account.Uid,
            email: account.Email,
        });
    }

    private Ok(body: object): Response
    {
        return new Response(JSON.stringify(body), { status: FakeIdentityPlatformRest.StatusOk, headers: { [FakeIdentityPlatformRest.ContentTypeHeader]: FakeIdentityPlatformRest.ContentType } });
    }

    private Error(message: string): Response
    {
        const body = { error: { code: FakeIdentityPlatformRest.StatusBadRequest, message } };
        return new Response(JSON.stringify(body), { status: FakeIdentityPlatformRest.StatusBadRequest, headers: { [FakeIdentityPlatformRest.ContentTypeHeader]: FakeIdentityPlatformRest.ContentType } });
    }
}
