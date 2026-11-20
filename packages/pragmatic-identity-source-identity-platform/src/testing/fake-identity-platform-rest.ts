import { decodeJwt } from "jose";
import { IdentityPlatformProvider } from "../client/identity-platform-provider.js";
import type { FakeIdentityPlatform } from "./fake-identity-platform.js";

class FakeAccount
{
    public Verified = false;

    public constructor(
        public readonly Uid: string,
        public readonly Email: string,
        public Password: string,
        public DisplayName: string | null)
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
 * :lookup), in memory, as a `fetch` implementation. Tokens are real ID tokens minted by the FakeIdentityPlatform, so
 * a page flow against this fake ends in a token the source verifies. `VerifyEmail` stands in for the person clicking
 * the verification link.
 */
export class FakeIdentityPlatformRest
{
    public static readonly ApiKey = "fake-browser-api-key";

    private static readonly KeyParam = "key";
    private static readonly SignUpPath = "accounts:signUp";
    private static readonly SignInPath = "accounts:signInWithPassword";
    private static readonly SendOobCodePath = "accounts:sendOobCode";
    private static readonly LookupPath = "accounts:lookup";
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
    private uidCounter = 0;

    public constructor(
        private readonly platform: FakeIdentityPlatform,
        private readonly apiKey: string = FakeIdentityPlatformRest.ApiKey,
        private readonly tenantId: string | null = null)
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
        return new Response(FakeIdentityPlatformRest.NotFound, { status: FakeIdentityPlatformRest.StatusNotFound });
    }

    private async SignUp(body: Record<string, unknown>): Promise<Response>
    {
        const email = String(body.email ?? "");
        const password = String(body.password ?? "");
        if (!email.includes(FakeIdentityPlatformRest.EmailAt))
        {
            return this.Error(FakeIdentityPlatformRest.InvalidEmail);
        }
        if (password === "")
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
        const account = this.accounts.get(String(body.email ?? ""));
        if (account === undefined || account.Password !== String(body.password ?? ""))
        {
            return this.Error(FakeIdentityPlatformRest.InvalidCredentials);
        }
        return this.SessionResponse(account);
    }

    private async SendOobCode(body: Record<string, unknown>): Promise<Response>
    {
        const requestType = String(body.requestType ?? "");
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
            const email = String(body.email ?? "");
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
            providerUserInfo: [{ providerId: IdentityPlatformProvider.Password, email: account.Email }],
        };
        if (account.DisplayName !== null)
        {
            user.displayName = account.DisplayName;
        }
        return this.Ok({ users: [user] });
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
