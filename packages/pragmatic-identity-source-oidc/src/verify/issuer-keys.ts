import { createLocalJWKSet } from "jose";
import type { JSONWebKeySet } from "jose";
import type { IHttpClient } from "../http/http-client.js";
import { TokenVerifierUnavailableError } from "./token-verifier-unavailable-error.js";

/** A key set tokens are verified against. */
export type IssuerKeySet = ReturnType<typeof createLocalJWKSet>;

/** How long discovery and keys are kept, and how often an unknown key id may refetch the keys. */
export interface IssuerKeysTiming
{
    DiscoveryTtlMs: number;
    KeysTtlMs: number;
    MinRefreshMs: number;
}

interface CachedJwksUri
{
    Uri: string;
    FetchedAt: number;
}

interface CachedKeys
{
    Uri: string;
    Set: IssuerKeySet;
    FetchedAt: number;
}

/**
 * One issuer's signing keys, found through its OIDC discovery document: the document must name the configured issuer
 * exactly and an https `jwks_uri`. Discovery and keys are cached (each for its lifetime); Rotated refetches the keys
 * for an unknown key id, at most once per refresh interval. A failed or unusable fetch is never cached and throws
 * TokenVerifierUnavailableError.
 */
export class IssuerKeys
{
    private static readonly IssuerField = "issuer";
    private static readonly JwksUriField = "jwks_uri";
    private static readonly HttpsProtocol = "https:";
    private static readonly DiscoveryUnreachable = "the issuer's discovery document cannot be fetched";
    private static readonly OtherIssuer = "the discovery document names another issuer";
    private static readonly NoKeysUri = "the discovery document names no https jwks_uri";
    private static readonly KeysUnreachable = "the issuer's keys cannot be fetched";
    private static readonly KeysInvalid = "the issuer's key set is not a JWK set";

    private jwksUri: CachedJwksUri | undefined;
    private keys: CachedKeys | undefined;
    private lastRefresh: number | undefined;

    public constructor(
        private readonly http: IHttpClient,
        private readonly discoveryUrl: string,
        private readonly issuer: string,
        private readonly timing: IssuerKeysTiming,
        private readonly now: () => Date)
    {
    }

    /** An https URL (the issuer, the discovery URL and the key set's must be). */
    public static IsHttps(url: string): boolean
    {
        try
        {
            return new URL(url).protocol === IssuerKeys.HttpsProtocol;
        }
        catch
        {
            return false;
        }
    }

    /** The current key set (fetched when absent or older than its lifetime). */
    public async Current(): Promise<IssuerKeySet>
    {
        const uri = await this.JwksUri();
        const cached = this.keys;
        if (cached !== undefined && cached.Uri === uri && this.Now() - cached.FetchedAt < this.timing.KeysTtlMs)
        {
            return cached.Set;
        }
        return this.Fetch(uri);
    }

    /** The keys fetched again for an unknown key id; undefined when the last such refresh is too recent. */
    public async Rotated(): Promise<IssuerKeySet | undefined>
    {
        const now = this.Now();
        if (this.lastRefresh !== undefined && now - this.lastRefresh < this.timing.MinRefreshMs)
        {
            return undefined;
        }
        this.lastRefresh = now;
        return this.Fetch(await this.JwksUri());
    }

    private async JwksUri(): Promise<string>
    {
        const K = IssuerKeys;
        const cached = this.jwksUri;
        if (cached !== undefined && this.Now() - cached.FetchedAt < this.timing.DiscoveryTtlMs)
        {
            return cached.Uri;
        }
        let doc: unknown;
        try
        {
            doc = await this.http.GetJson(this.discoveryUrl);
        }
        catch
        {
            throw new TokenVerifierUnavailableError(K.DiscoveryUnreachable);
        }
        const fields = doc !== null && typeof doc === "object" ? doc as Record<string, unknown> : {};
        if (fields[K.IssuerField] !== this.issuer)
        {
            throw new TokenVerifierUnavailableError(K.OtherIssuer);
        }
        const uri = fields[K.JwksUriField];
        if (typeof uri !== "string" || !K.IsHttps(uri))
        {
            throw new TokenVerifierUnavailableError(K.NoKeysUri);
        }
        this.jwksUri = { Uri: uri, FetchedAt: this.Now() };
        return uri;
    }

    private async Fetch(uri: string): Promise<IssuerKeySet>
    {
        let jwks: unknown;
        try
        {
            jwks = await this.http.GetJson(uri);
        }
        catch
        {
            throw new TokenVerifierUnavailableError(IssuerKeys.KeysUnreachable);
        }
        let set: IssuerKeySet;
        try
        {
            set = createLocalJWKSet(jwks as JSONWebKeySet);
        }
        catch
        {
            throw new TokenVerifierUnavailableError(IssuerKeys.KeysInvalid);
        }
        this.keys = { Uri: uri, Set: set, FetchedAt: this.Now() };
        return set;
    }

    private Now(): number
    {
        return this.now().getTime();
    }
}
