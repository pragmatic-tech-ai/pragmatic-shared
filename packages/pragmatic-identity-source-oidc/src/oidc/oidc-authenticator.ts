import { randomBytes } from "node:crypto";
import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { AuthMethod, AuthenticatedResult, RejectedResult } from "@pragmatic-tech-ai/pragmatic-identity";
import type {
    AuthenticationResult,
    Credential,
    IAuthenticator,
    IdentityConfig,
    ISecretStore,
    PresentedSecret,
    Realm,
} from "@pragmatic-tech-ai/pragmatic-identity";
import type { IHttpClient } from "../http/http-client.js";
import type { OidcDiscovery } from "./oidc-discovery.js";
import type { JwksCache } from "./jwks-cache.js";
import type { IOidcFlowStateStore } from "./flow-state-store.js";
import type { ClaimsMapper } from "../claims/claims-mapper.js";
import type { OidcResolvedConfig } from "./oidc-resolved-config.js";
import { UpstreamTokens } from "../obo/upstream-token-vault.js";
import type { UpstreamTokenVault } from "../obo/upstream-token-vault.js";
import { PkceChallenge } from "./pkce-challenge.js";
import { OidcFlowState } from "./oidc-flow-state.js";
import { AuthorizationRequest } from "./authorization-request.js";
import { OidcSignInOutcome, OidcTokenSet } from "./oidc-token-set.js";

/** How one sign-in is begun. */
export interface OidcBeginOptions
{
    /** Ask the issuer to open on account creation (`prompt=create`); sent only when its discovery document advertises
     *  `create` in `prompt_values_supported`, otherwise the flow begins as a plain sign-in. */
    SignUp?: boolean;
    /** Passed through as `login_hint`. */
    LoginHint?: string;
    /** Carried in the flow state and handed back with the completed sign-in (OidcSignInOutcome.ReturnPath). */
    ReturnPath?: string;
}

export interface OidcAuthenticatorOptions
{
    Http: IHttpClient;
    Discovery: OidcDiscovery;
    Jwks: JwksCache;
    FlowStates: IOidcFlowStateStore;
    Secrets: ISecretStore;
    Claims: ClaimsMapper;
    Config: IdentityConfig;
    Resolved: OidcResolvedConfig;
    Vault?: UpstreamTokenVault;
    now?: () => Date;
}

export class OidcAuthenticator implements IAuthenticator
{
    private static readonly StateBytes = 32;
    private static readonly RandomEncoding = "base64url";
    private static readonly FlowTtlMs = 600_000;
    private static readonly RejectionReason = "authentication failed";
    private static readonly GrantTypeParam = "grant_type";
    private static readonly GrantTypeAuthorizationCode = "authorization_code";
    private static readonly GrantTypeRefreshToken = "refresh_token";
    private static readonly RefreshTokenParam = "refresh_token";
    private static readonly ExpiresInField = "expires_in";
    private static readonly MsPerSecond = 1000;
    private static readonly CodeParam = "code";
    private static readonly CodeVerifierParam = "code_verifier";
    private static readonly RedirectUriParam = "redirect_uri";
    private static readonly ClientIdParam = "client_id";
    private static readonly IdTokenField = "id_token";
    private static readonly AccessTokenField = "access_token";
    private static readonly RefreshTokenField = "refresh_token";
    private static readonly NonceClaim = "nonce";
    private static readonly AllowedAlgs = ["RS256", "ES256"] as const;
    private static readonly ClockToleranceSec = 60;
    private static readonly NoMatchingKeyCode = "ERR_JWKS_NO_MATCHING_KEY";
    private static readonly PromptCreate = "create";

    public readonly Method = AuthMethod.Oidc;

    private readonly now: () => Date;

    public constructor(private readonly opts: OidcAuthenticatorOptions)
    {
        this.now = opts.now ?? (() => new Date());
    }

    public async BeginAuthorization(_realm: Realm, begin: OidcBeginOptions = {}): Promise<{ Url: string; State: string }>
    {
        const resolved = this.opts.Resolved;
        const endpoints = await this.opts.Discovery.Endpoints(resolved.DiscoveryUrl);
        const pkce = PkceChallenge.Create();
        const state = randomBytes(OidcAuthenticator.StateBytes).toString(OidcAuthenticator.RandomEncoding);
        const nonce = randomBytes(OidcAuthenticator.StateBytes).toString(OidcAuthenticator.RandomEncoding);
        const expiresAt = new Date(this.now().getTime() + OidcAuthenticator.FlowTtlMs);
        await this.opts.FlowStates.Put(new OidcFlowState(state, nonce, pkce.Verifier, resolved.RedirectUri, expiresAt, begin.ReturnPath ?? null));
        const signUp = begin.SignUp === true && endpoints.PromptValues.includes(OidcAuthenticator.PromptCreate);
        const url = AuthorizationRequest.Build({
            AuthorizationEndpoint: endpoints.AuthorizationEndpoint,
            ClientId: resolved.ClientId,
            RedirectUri: resolved.RedirectUri,
            Scopes: resolved.Scopes,
            State: state,
            Nonce: nonce,
            Challenge: pkce.Challenge,
            Prompt: signUp ? OidcAuthenticator.PromptCreate : undefined,
            LoginHint: begin.LoginHint,
        });
        return { Url: url, State: state };
    }

    public async Authenticate(credential: Credential, presented: PresentedSecret, realm: Realm): Promise<AuthenticationResult>
    {
        return (await this.AuthenticateWithTokens(credential, presented, realm)).Result;
    }

    /**
     * Authenticate, also handing back the sign-in's upstream tokens (the verified ID token, the access and refresh
     * tokens when issued) for a relying party that calls downstream services on the subject's behalf. A rejection
     * carries no tokens.
     */
    public async AuthenticateWithTokens(credential: Credential, presented: PresentedSecret, realm: Realm): Promise<OidcSignInOutcome<AuthenticationResult>>
    {
        try
        {
            const flow = await this.opts.FlowStates.Take(credential.Reference);
            if (flow === null)
            {
                return this.Rejected();
            }

            const resolved = this.opts.Resolved;
            const endpoints = await this.opts.Discovery.Endpoints(resolved.DiscoveryUrl);

            const fields = new Map<string, string>();
            fields.set(OidcAuthenticator.GrantTypeParam, OidcAuthenticator.GrantTypeAuthorizationCode);
            fields.set(OidcAuthenticator.CodeParam, presented.Reveal());
            fields.set(OidcAuthenticator.CodeVerifierParam, flow.CodeVerifier);
            fields.set(OidcAuthenticator.RedirectUriParam, resolved.RedirectUri);
            fields.set(OidcAuthenticator.ClientIdParam, resolved.ClientId);
            await this.AddClientSecret(fields);

            const tokenResponse = await this.opts.Http.PostForm(endpoints.TokenEndpoint, fields);
            const idToken = (tokenResponse as Record<string, unknown> | null)?.[OidcAuthenticator.IdTokenField];
            if (typeof idToken !== "string")
            {
                return this.Rejected();
            }

            const payload = await this.VerifyIdToken(idToken, endpoints.JwksUri);
            if (payload === null || payload[OidcAuthenticator.NonceClaim] !== flow.Nonce)
            {
                return this.Rejected();
            }

            const principal = this.opts.Claims.Map(payload as Record<string, unknown>, realm, this.opts.Config);
            await this.StoreUpstream(realm, principal.Id, tokenResponse);
            return new OidcSignInOutcome<AuthenticationResult>(new AuthenticatedResult(principal), this.TokenSetOf(payload, idToken, tokenResponse, null), flow.ReturnPath);
        }
        catch
        {
            return this.Rejected();
        }
    }

    /**
     * Redeems a refresh token at the issuer's token endpoint for a fresh token set of `subject`. The answer must carry
     * an ID token that verifies (signature, issuer, audience, expiry; no nonce, which OIDC Core 12.2 leaves out) and
     * names the same subject. A refresh token the issuer did not rotate is kept. Null for any refusal; never throws.
     */
    public async Refresh(refreshToken: string, subject: string): Promise<OidcTokenSet | null>
    {
        try
        {
            const resolved = this.opts.Resolved;
            const endpoints = await this.opts.Discovery.Endpoints(resolved.DiscoveryUrl);
            const fields = new Map<string, string>();
            fields.set(OidcAuthenticator.GrantTypeParam, OidcAuthenticator.GrantTypeRefreshToken);
            fields.set(OidcAuthenticator.RefreshTokenParam, refreshToken);
            fields.set(OidcAuthenticator.ClientIdParam, resolved.ClientId);
            await this.AddClientSecret(fields);
            const tokenResponse = await this.opts.Http.PostForm(endpoints.TokenEndpoint, fields);
            const idToken = (tokenResponse as Record<string, unknown> | null)?.[OidcAuthenticator.IdTokenField];
            if (typeof idToken !== "string")
            {
                return null;
            }
            const payload = await this.VerifyIdToken(idToken, endpoints.JwksUri);
            if (payload === null || payload.sub !== subject)
            {
                return null;
            }
            return this.TokenSetOf(payload, idToken, tokenResponse, refreshToken);
        }
        catch
        {
            return null;
        }
    }

    private async AddClientSecret(fields: Map<string, string>): Promise<void>
    {
        const resolved = this.opts.Resolved;
        if (resolved.SecretRef !== null)
        {
            const secret = await this.opts.Secrets.Get(resolved.SecretRef);
            if (secret !== null)
            {
                fields.set(resolved.ClientSecretParam, secret);
            }
        }
    }

    /** The ID token's verified claims (RS256/ES256 on the issuer's keys, refetched once for an unknown kid), or null. */
    private async VerifyIdToken(idToken: string, jwksUri: string): Promise<JWTPayload | null>
    {
        const resolved = this.opts.Resolved;
        const verifyOptions = {
            issuer: resolved.Issuer,
            audience: resolved.ClientId,
            algorithms: [...OidcAuthenticator.AllowedAlgs],
            clockTolerance: OidcAuthenticator.ClockToleranceSec,
            requiredClaims: [...resolved.RequiredClaims],
        };
        try
        {
            return (await jwtVerify(idToken, await this.opts.Jwks.KeySet(jwksUri), verifyOptions)).payload;
        }
        catch (e)
        {
            if (!this.IsNoMatchingKey(e))
            {
                return null;
            }
        }
        try
        {
            return (await jwtVerify(idToken, await this.opts.Jwks.Refresh(jwksUri), verifyOptions)).payload;
        }
        catch
        {
            return null;
        }
    }

    private TokenSetOf(payload: JWTPayload, idToken: string, tokenResponse: unknown, keptRefreshToken: string | null): OidcTokenSet | null
    {
        const A = OidcAuthenticator;
        if (typeof payload.sub !== "string" || typeof payload.exp !== "number")
        {
            return null;
        }
        const body = tokenResponse as Record<string, unknown>;
        const access = body[A.AccessTokenField];
        const refresh = body[A.RefreshTokenField];
        const expiresIn = body[A.ExpiresInField];
        const accessToken = typeof access === "string" ? access : null;
        const accessExpiresAt = accessToken !== null && typeof expiresIn === "number" && expiresIn > 0
            ? new Date(this.now().getTime() + expiresIn * A.MsPerSecond)
            : null;
        return new OidcTokenSet(payload.sub, idToken, new Date(payload.exp * A.MsPerSecond), accessToken, accessExpiresAt, typeof refresh === "string" ? refresh : keptRefreshToken);
    }

    private async StoreUpstream(realm: Realm, principalId: string, tokenResponse: unknown): Promise<void>
    {
        const vault = this.opts.Vault;
        if (vault === undefined) return;
        const body = tokenResponse as Record<string, unknown>;
        const access = body[OidcAuthenticator.AccessTokenField];
        if (typeof access !== "string") return;
        const refresh = body[OidcAuthenticator.RefreshTokenField];
        await vault.Put(realm.Id, principalId, new UpstreamTokens(access, typeof refresh === "string" ? refresh : null));
    }

    private IsNoMatchingKey(e: unknown): boolean
    {
        return (e as { code?: string } | null)?.code === OidcAuthenticator.NoMatchingKeyCode;
    }

    private Rejected(): OidcSignInOutcome<AuthenticationResult>
    {
        return new OidcSignInOutcome<AuthenticationResult>(new RejectedResult(OidcAuthenticator.RejectionReason), null);
    }
}
