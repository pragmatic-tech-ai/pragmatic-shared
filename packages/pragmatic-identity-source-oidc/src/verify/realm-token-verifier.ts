import { errors as JoseErrors, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { IHttpClient } from "../http/http-client.js";
import { OidcHttpClients } from "../http/oidc-http-clients.js";
import { IssuerKeys } from "./issuer-keys.js";
import type { IssuerKeySet } from "./issuer-keys.js";
import { RealmTokenPrincipal } from "./realm-token-principal.js";
import type { RealmTokenVerifierOptions } from "./realm-token-verifier-options.js";
import type { IRealmTokenVerifier } from "./token-verifier.js";

/**
 * Verifies tokens issued by one realm issuer (the central realm or any other), for relying parties that receive a
 * bearer token rather than running a sign-in: the signature on the issuer's keys (found through its OIDC discovery
 * document, cached, refetched on an unknown key id for rotation), the issuer exactly, the audience (one of the
 * configured), the authorized party when configured, the header's `typ` when configured (an RFC 9068 access token), exp
 * / nbf / iat within the clock skew, a non-empty subject, the required claims and, when asked, an email (verified).
 * Asymmetric algorithms only. Answers a RealmTokenPrincipal, or undefined for any token that is not valid; throws
 * TokenVerifierUnavailableError only when it cannot decide.
 */
export class RealmTokenVerifier implements IRealmTokenVerifier
{
    private static readonly DiscoverySuffix = "/.well-known/openid-configuration";
    private static readonly TrailingSlashes = /\/+$/;
    private static readonly DefaultAlgorithms: readonly string[] = ["RS256", "ES256"];
    private static readonly ForbiddenAlgorithm = /^(HS|none$)/i;
    private static readonly BaseRequiredClaims: readonly string[] = ["iss", "sub", "aud", "exp", "iat"];
    private static readonly DefaultClockSkewSeconds = 60;
    private static readonly DefaultDiscoveryTtlSeconds = 300;
    private static readonly DefaultKeysTtlSeconds = 3600;
    private static readonly DefaultMinKeyRefreshSeconds = 60;
    private static readonly MaxTokenLength = 16_384;
    private static readonly MsPerSecond = 1000;
    private static readonly NoIssuer = "RealmTokenVerifier: the issuer must be an https URL";
    private static readonly NoAudience = "RealmTokenVerifier: at least one non-empty audience is required";
    private static readonly InsecureDiscovery = "RealmTokenVerifier: the discovery URL must be https";
    private static readonly BadAlgorithm = "RealmTokenVerifier: only asymmetric signature algorithms are accepted: ";

    private readonly issuer: string;
    private readonly audience: readonly string[];
    private readonly authorizedParties: readonly string[] | undefined;
    private readonly type: string | undefined;
    private readonly algorithms: readonly string[];
    private readonly skewSeconds: number;
    private readonly requiredClaims: readonly string[];
    private readonly requireEmail: boolean;
    private readonly requireVerifiedEmail: boolean;
    private readonly now: () => Date;
    private readonly keys: IssuerKeys;

    public constructor(options: RealmTokenVerifierOptions)
    {
        const V = RealmTokenVerifier;
        if (!IssuerKeys.IsHttps(options.Issuer))
        {
            throw new Error(V.NoIssuer);
        }
        const audience = typeof options.Audience === "string" ? [options.Audience] : [...options.Audience];
        if (audience.length === 0 || audience.some(a => a.length === 0))
        {
            throw new Error(V.NoAudience);
        }
        const discoveryUrl = options.DiscoveryUrl ?? options.Issuer.replace(V.TrailingSlashes, "") + V.DiscoverySuffix;
        if (!IssuerKeys.IsHttps(discoveryUrl))
        {
            throw new Error(V.InsecureDiscovery);
        }
        const algorithms = options.Algorithms ?? V.DefaultAlgorithms;
        for (const algorithm of algorithms)
        {
            if (V.ForbiddenAlgorithm.test(algorithm))
            {
                throw new Error(V.BadAlgorithm + algorithm);
            }
        }
        this.issuer = options.Issuer;
        this.audience = audience;
        this.authorizedParties = options.AuthorizedParties === undefined ? undefined : [...options.AuthorizedParties];
        this.type = options.Type;
        this.algorithms = [...algorithms];
        this.skewSeconds = options.ClockSkewSeconds ?? V.DefaultClockSkewSeconds;
        this.requiredClaims = [...V.BaseRequiredClaims, ...(options.RequiredClaims ?? [])];
        this.requireVerifiedEmail = options.RequireVerifiedEmail ?? false;
        this.requireEmail = this.requireVerifiedEmail || (options.RequireEmail ?? false);
        this.now = options.Now ?? (() => new Date());
        const http: IHttpClient = options.Http ?? OidcHttpClients.Create(options.CaBundleFile);
        this.keys = new IssuerKeys(http, discoveryUrl, this.issuer, {
            DiscoveryTtlMs: (options.DiscoveryTtlSeconds ?? V.DefaultDiscoveryTtlSeconds) * V.MsPerSecond,
            KeysTtlMs: (options.KeysTtlSeconds ?? V.DefaultKeysTtlSeconds) * V.MsPerSecond,
            MinRefreshMs: (options.MinKeyRefreshSeconds ?? V.DefaultMinKeyRefreshSeconds) * V.MsPerSecond,
        }, this.now);
    }

    /** The issuer this verifier trusts. */
    public get Issuer(): string
    {
        return this.issuer;
    }

    public async Verify(token: string): Promise<RealmTokenPrincipal | undefined>
    {
        if (typeof token !== "string" || token.length === 0 || token.length > RealmTokenVerifier.MaxTokenLength)
        {
            return undefined;
        }
        const current = await this.keys.Current();
        try
        {
            return await this.Check(token, current);
        }
        catch (err)
        {
            if (!(err instanceof JoseErrors.JWKSNoMatchingKey))
            {
                return undefined;
            }
        }
        const rotated = await this.keys.Rotated();
        if (rotated === undefined)
        {
            return undefined;
        }
        try
        {
            return await this.Check(token, rotated);
        }
        catch
        {
            return undefined;
        }
    }

    private async Check(token: string, keys: IssuerKeySet): Promise<RealmTokenPrincipal | undefined>
    {
        const now = this.now();
        const { payload } = await jwtVerify(token, keys, {
            issuer: this.issuer,
            audience: [...this.audience],
            algorithms: [...this.algorithms],
            clockTolerance: this.skewSeconds,
            requiredClaims: [...this.requiredClaims],
            currentDate: now,
            ...(this.type === undefined ? {} : { typ: this.type }),
        });
        return this.Accept(payload, now);
    }

    // What jose leaves to the caller: a non-empty subject, iat not in the future, azp and the email requirements.
    private Accept(payload: JWTPayload, now: Date): RealmTokenPrincipal | undefined
    {
        if (typeof payload.sub !== "string" || payload.sub.length === 0)
        {
            return undefined;
        }
        const nowSeconds = Math.floor(now.getTime() / RealmTokenVerifier.MsPerSecond);
        if (typeof payload.iat !== "number" || payload.iat > nowSeconds + this.skewSeconds)
        {
            return undefined;
        }
        const principal = new RealmTokenPrincipal(this.issuer, payload.sub, payload as Record<string, unknown>);
        const azp = principal.AuthorizedParty;
        if (this.authorizedParties !== undefined && (azp === undefined || !this.authorizedParties.includes(azp)))
        {
            return undefined;
        }
        if (this.requireEmail && principal.Email === undefined)
        {
            return undefined;
        }
        return this.requireVerifiedEmail && !principal.EmailVerified ? undefined : principal;
    }
}
