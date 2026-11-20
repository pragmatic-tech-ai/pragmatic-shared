import { FetchIdentityPlatformHttp } from "./fetch-identity-platform-http.js";
import type { IdentityPlatformHttpResponse, IIdentityPlatformHttp } from "./identity-platform-http.js";
import { IdentityPlatformAuthUri } from "./identity-platform-auth-uri.js";
import { IdentityPlatformIdpSession } from "./identity-platform-idp-session.js";
import type { IdentityPlatformPageConfig } from "./identity-platform-page-config.js";
import { IdentityPlatformRestError } from "./identity-platform-rest-error.js";
import { IdentityPlatformSession } from "./identity-platform-session.js";
import { IdentityPlatformUser } from "./identity-platform-user.js";

interface SessionBody
{
    localId?: unknown;
    email?: unknown;
    idToken?: unknown;
    refreshToken?: unknown;
    expiresIn?: unknown;
}

interface AuthUriBody
{
    authUri?: unknown;
    sessionId?: unknown;
    providerId?: unknown;
}

interface IdpSessionBody extends SessionBody
{
    providerId?: unknown;
    emailVerified?: unknown;
    displayName?: unknown;
    isNewUser?: unknown;
    needConfirmation?: unknown;
    errorMessage?: unknown;
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
 * The login page's Identity Platform client: the identitytoolkit v1 REST endpoints over an IIdentityPlatformHttp
 * (default FetchIdentityPlatformHttp; browser-safe: no Node APIs, no SDK). The browser API key goes in the `key` query
 * parameter; the browser adds the Referer the key is restricted to. The ID token a sign-in returns is what the page
 * posts to the realm sign-in service.
 *
 * Federated sign-in (Google through Identity Platform): CreateAuthUri gives the provider's authorization URL and a
 * session id; the provider sends the browser back to the continue URI with its answer in the URL's fragment
 * (Identity Platform asks Google for `response_type=id_token`); SignInWithIdp exchanges that whole URL (the page's
 * `location.href`, fragment included) and the session id for an Identity Platform session.
 */
export class IdentityPlatformRestClient
{
    public static readonly DefaultBaseUrl = "https://identitytoolkit.googleapis.com/v1/";

    private static readonly SignUpPath = "accounts:signUp";
    private static readonly SignInPath = "accounts:signInWithPassword";
    private static readonly SendOobCodePath = "accounts:sendOobCode";
    private static readonly LookupPath = "accounts:lookup";
    private static readonly CreateAuthUriPath = "accounts:createAuthUri";
    private static readonly SignInWithIdpPath = "accounts:signInWithIdp";
    private static readonly KeyParam = "key";
    private static readonly TenantField = "tenantId";
    private static readonly CustomParameterField = "customParameter";
    private static readonly VerifyEmailRequest = "VERIFY_EMAIL";
    private static readonly PasswordResetRequest = "PASSWORD_RESET";
    private static readonly MissingFieldCode = "MALFORMED_RESPONSE";
    private static readonly MissingFieldDetail = "a response field is missing";
    private static readonly NoUserCode = "USER_NOT_FOUND";
    private static readonly NeedConfirmationCode = "NEED_CONFIRMATION";
    private static readonly NeedConfirmationDetail = "the email belongs to an account of another sign-in method; confirm it first";
    private static readonly Empty = "";

    private readonly http: IIdentityPlatformHttp;

    /** `transport`: an IIdentityPlatformHttp, or a fetch (may be unbound) wrapped in FetchIdentityPlatformHttp; default the global fetch. */
    public constructor(
        private readonly apiKey: string,
        private readonly tenantId: string | null = null,
        transport: IIdentityPlatformHttp | typeof fetch = new FetchIdentityPlatformHttp(),
        private readonly baseUrl: string = IdentityPlatformRestClient.DefaultBaseUrl)
    {
        this.http = typeof transport === "function" ? new FetchIdentityPlatformHttp(transport) : transport;
    }

    /** A client over fetch: `fetchFn` (the global fetch when absent) may be passed unbound. */
    public static For(config: IdentityPlatformPageConfig, fetchFn?: typeof fetch): IdentityPlatformRestClient
    {
        return IdentityPlatformRestClient.WithHttp(config, new FetchIdentityPlatformHttp(fetchFn ?? null));
    }

    /** A client over the given transport. */
    public static WithHttp(config: IdentityPlatformPageConfig, http: IIdentityPlatformHttp): IdentityPlatformRestClient
    {
        return new IdentityPlatformRestClient(config.ApiKey, config.TenantId, http);
    }

    /** Creates an email/password account and signs it in (its email is not verified yet). */
    public async SignUp(email: string, password: string): Promise<IdentityPlatformSession>
    {
        return IdentityPlatformRestClient.Session(await this.Post(IdentityPlatformRestClient.SignUpPath, { email, password, returnSecureToken: true }));
    }

    public async SignInWithPassword(email: string, password: string): Promise<IdentityPlatformSession>
    {
        return IdentityPlatformRestClient.Session(await this.Post(IdentityPlatformRestClient.SignInPath, { email, password, returnSecureToken: true }));
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

    /**
     * Starts a sign-in with an upstream provider (`providerId`, e.g. `google.com`): the provider's authorization URL,
     * which sends the browser back to `continueUri` (on an authorized domain of the project, and a redirect URI of the
     * provider's OAuth client). `customParameters` go to the provider (e.g. `login_hint`, `prompt`).
     */
    public async CreateAuthUri(providerId: string, continueUri: string, customParameters?: ReadonlyMap<string, string>): Promise<IdentityPlatformAuthUri>
    {
        const fields: Record<string, unknown> = { providerId, continueUri };
        if (customParameters !== undefined && customParameters.size > 0)
        {
            fields[IdentityPlatformRestClient.CustomParameterField] = Object.fromEntries(customParameters);
        }
        const body = await this.Post(IdentityPlatformRestClient.CreateAuthUriPath, fields) as AuthUriBody;
        if (typeof body.authUri !== "string" || typeof body.sessionId !== "string")
        {
            throw IdentityPlatformRestClient.Malformed();
        }
        return new IdentityPlatformAuthUri(body.authUri, body.sessionId, IdentityPlatformRestClient.StringOr(body.providerId, providerId));
    }

    /**
     * Completes a federated sign-in: `requestUri` is the whole URL the provider sent the browser back to (the continue
     * URI with the provider's answer in its fragment: pass `location.href`, never origin + path + query), `sessionId`
     * the one CreateAuthUri gave. An answer that needs confirmation (the email belongs to an account of another method
     * the provider is not authoritative over) is the error NEED_CONFIRMATION; an `errorMessage` in the answer is the
     * error of that code. Both keep the answer's HTTP status (200).
     */
    public async SignInWithIdp(requestUri: string, sessionId: string): Promise<IdentityPlatformIdpSession>
    {
        const response = await this.PostFor(IdentityPlatformRestClient.SignInWithIdpPath, { requestUri, sessionId, returnSecureToken: true, returnIdpCredential: true });
        const body = IdentityPlatformRestClient.Fields(response.Body) as IdpSessionBody;
        if (typeof body.errorMessage === "string" && body.errorMessage !== IdentityPlatformRestClient.Empty)
        {
            throw IdentityPlatformRestError.FromMessage(response.Status, body.errorMessage);
        }
        if (body.needConfirmation === true)
        {
            throw new IdentityPlatformRestError(IdentityPlatformRestClient.NeedConfirmationCode, response.Status, IdentityPlatformRestClient.NeedConfirmationDetail);
        }
        const session = IdentityPlatformRestClient.Session(body);
        return new IdentityPlatformIdpSession(
            session.Uid,
            session.Email,
            session.IdToken,
            session.RefreshToken,
            session.ExpiresInSeconds,
            IdentityPlatformRestClient.StringOr(body.providerId, IdentityPlatformRestClient.Empty),
            body.emailVerified === true,
            typeof body.displayName === "string" ? body.displayName : null,
            body.isNewUser === true);
    }

    private static StringOr(value: unknown, fallback: string): string
    {
        return typeof value === "string" ? value : fallback;
    }

    private static Malformed(): IdentityPlatformRestError
    {
        return new IdentityPlatformRestError(IdentityPlatformRestClient.MissingFieldCode, 0, IdentityPlatformRestClient.MissingFieldDetail);
    }

    private static Session(body: SessionBody): IdentityPlatformSession
    {
        if (typeof body.localId !== "string" || typeof body.idToken !== "string")
        {
            throw IdentityPlatformRestClient.Malformed();
        }
        return new IdentityPlatformSession(
            body.localId,
            IdentityPlatformRestClient.StringOr(body.email, IdentityPlatformRestClient.Empty),
            body.idToken,
            IdentityPlatformRestClient.StringOr(body.refreshToken, IdentityPlatformRestClient.Empty),
            Number(body.expiresIn ?? 0));
    }

    private static Fields(body: unknown): Record<string, unknown>
    {
        return body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    }

    private async Post(path: string, fields: Record<string, unknown>): Promise<Record<string, unknown>>
    {
        return IdentityPlatformRestClient.Fields((await this.PostFor(path, fields)).Body);
    }

    /** The successful answer (a failed one throws its error). */
    private async PostFor(path: string, fields: Record<string, unknown>): Promise<IdentityPlatformHttpResponse>
    {
        // Concatenated, not new URL(path, base): "accounts:signUp" parses as an absolute URL with scheme "accounts:".
        const url = new URL(this.baseUrl + path);
        url.searchParams.set(IdentityPlatformRestClient.KeyParam, this.apiKey);
        const body = this.tenantId === null ? fields : { ...fields, [IdentityPlatformRestClient.TenantField]: this.tenantId };
        const response = await this.http.PostJson(url.href, body);
        if (!response.Ok)
        {
            throw IdentityPlatformRestError.FromBody(response.Status, response.Body);
        }
        return response;
    }
}
