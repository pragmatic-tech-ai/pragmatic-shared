import type { IdentityPlatformPageConfig } from "./identity-platform-page-config.js";
import { IdentityPlatformRestError } from "./identity-platform-rest-error.js";
import { IdentityPlatformSession } from "./identity-platform-session.js";
import { IdentityPlatformUser } from "./identity-platform-user.js";

interface SessionBody
{
    localId?: string;
    email?: string;
    idToken?: string;
    refreshToken?: string;
    expiresIn?: string;
}

interface LookupBody
{
    users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        displayName?: string;
        disabled?: boolean;
        providerUserInfo?: Array<{ providerId?: string }>;
    }>;
}

/**
 * The login page's Identity Platform client: the identitytoolkit v1 REST endpoints, driven with fetch (browser-safe:
 * no Node APIs, no SDK). The browser API key goes in the `key` query parameter; the browser adds the Referer the key
 * is restricted to. The ID token a sign-in returns is what the page posts to the realm sign-in service.
 */
export class IdentityPlatformRestClient
{
    public static readonly DefaultBaseUrl = "https://identitytoolkit.googleapis.com/v1/";

    private static readonly SignUpPath = "accounts:signUp";
    private static readonly SignInPath = "accounts:signInWithPassword";
    private static readonly SendOobCodePath = "accounts:sendOobCode";
    private static readonly LookupPath = "accounts:lookup";
    private static readonly KeyParam = "key";
    private static readonly PostMethod = "POST";
    private static readonly ContentTypeHeader = "content-type";
    private static readonly JsonContentType = "application/json";
    private static readonly VerifyEmailRequest = "VERIFY_EMAIL";
    private static readonly PasswordResetRequest = "PASSWORD_RESET";
    private static readonly MissingFieldCode = "MALFORMED_RESPONSE";
    private static readonly MissingFieldDetail = "a response field is missing";
    private static readonly NoUserCode = "USER_NOT_FOUND";
    private static readonly Empty = "";

    private readonly fetchFn: typeof fetch;

    public constructor(
        private readonly apiKey: string,
        private readonly tenantId: string | null = null,
        fetchFn?: typeof fetch,
        private readonly baseUrl: string = IdentityPlatformRestClient.DefaultBaseUrl)
    {
        this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
    }

    public static For(config: IdentityPlatformPageConfig, fetchFn?: typeof fetch): IdentityPlatformRestClient
    {
        return new IdentityPlatformRestClient(config.ApiKey, config.TenantId, fetchFn);
    }

    /** Creates an email/password account and signs it in (its email is not verified yet). */
    public async SignUp(email: string, password: string): Promise<IdentityPlatformSession>
    {
        return this.Session(await this.Post(IdentityPlatformRestClient.SignUpPath, { email, password, returnSecureToken: true }) as SessionBody);
    }

    public async SignInWithPassword(email: string, password: string): Promise<IdentityPlatformSession>
    {
        return this.Session(await this.Post(IdentityPlatformRestClient.SignInPath, { email, password, returnSecureToken: true }) as SessionBody);
    }

    /** Sends the verification email to the signed-in account. */
    public async SendEmailVerification(idToken: string): Promise<void>
    {
        await this.Post(IdentityPlatformRestClient.SendOobCodePath, { requestType: IdentityPlatformRestClient.VerifyEmailRequest, idToken });
    }

    /** Sends a password-reset email (the answer does not tell whether the account exists). */
    public async SendPasswordReset(email: string): Promise<void>
    {
        await this.Post(IdentityPlatformRestClient.SendOobCodePath, { requestType: IdentityPlatformRestClient.PasswordResetRequest, email });
    }

    /** The signed-in account as Identity Platform holds it now (e.g. whether the email got verified meanwhile). */
    public async Lookup(idToken: string): Promise<IdentityPlatformUser>
    {
        const body = await this.Post(IdentityPlatformRestClient.LookupPath, { idToken }) as LookupBody;
        const user = body.users?.[0];
        if (user === undefined || typeof user.localId !== "string")
        {
            throw new IdentityPlatformRestError(IdentityPlatformRestClient.NoUserCode, 0, IdentityPlatformRestClient.NoUserCode);
        }
        const providers = (user.providerUserInfo ?? []).map(info => info.providerId).filter((id): id is string => typeof id === "string");
        return new IdentityPlatformUser(user.localId, user.email ?? null, user.emailVerified === true, user.displayName ?? null, providers, user.disabled === true);
    }

    private Session(body: SessionBody): IdentityPlatformSession
    {
        if (typeof body.localId !== "string" || typeof body.idToken !== "string")
        {
            throw new IdentityPlatformRestError(IdentityPlatformRestClient.MissingFieldCode, 0, IdentityPlatformRestClient.MissingFieldDetail);
        }
        return new IdentityPlatformSession(
            body.localId,
            body.email ?? IdentityPlatformRestClient.Empty,
            body.idToken,
            body.refreshToken ?? IdentityPlatformRestClient.Empty,
            Number(body.expiresIn ?? 0));
    }

    private async Post(path: string, fields: Record<string, unknown>): Promise<unknown>
    {
        // Concatenated, not new URL(path, base): "accounts:signUp" parses as an absolute URL with scheme "accounts:".
        const url = new URL(this.baseUrl + path);
        url.searchParams.set(IdentityPlatformRestClient.KeyParam, this.apiKey);
        const body = this.tenantId === null ? fields : { ...fields, tenantId: this.tenantId };
        const response = await this.fetchFn(url.href, {
            method: IdentityPlatformRestClient.PostMethod,
            headers: { [IdentityPlatformRestClient.ContentTypeHeader]: IdentityPlatformRestClient.JsonContentType },
            body: JSON.stringify(body),
        });
        const json: unknown = await response.json().catch(() => null);
        if (!response.ok)
        {
            throw IdentityPlatformRestError.FromBody(response.status, json);
        }
        return json;
    }
}
