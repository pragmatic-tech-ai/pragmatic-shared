import type { IHttpClient } from "../http/http-client.js";
import { OidcEndpoints } from "./oidc-endpoints.js";

interface CachedEndpoints
{
    value: OidcEndpoints;
    expiresAt: number;
}

export class OidcDiscovery
{
    private static readonly TtlMs = 300_000;
    private static readonly IssuerField = "issuer";
    private static readonly AuthorizationEndpointField = "authorization_endpoint";
    private static readonly TokenEndpointField = "token_endpoint";
    private static readonly JwksUriField = "jwks_uri";
    private static readonly PromptValuesField = "prompt_values_supported";
    private static readonly EndSessionEndpointField = "end_session_endpoint";
    private static readonly HttpsProtocol = "https:";
    private static readonly InvalidDocumentError = "OIDC discovery document is invalid";
    private static readonly InsecureEndpointError = "OIDC discovery endpoint must use https";

    private readonly cache = new Map<string, CachedEndpoints>();

    public constructor(
        private readonly http: IHttpClient,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Endpoints(discoveryUrl: string): Promise<OidcEndpoints>
    {
        const cached = this.cache.get(discoveryUrl);
        if (cached && this.now().getTime() < cached.expiresAt)
        {
            return cached.value;
        }

        OidcDiscovery.RequireHttps(discoveryUrl);
        const doc = await this.http.GetJson(discoveryUrl) as Record<string, unknown> | null;
        const issuer = OidcDiscovery.RequiredString(doc, OidcDiscovery.IssuerField);
        const authorization = OidcDiscovery.RequiredString(doc, OidcDiscovery.AuthorizationEndpointField);
        const token = OidcDiscovery.RequiredString(doc, OidcDiscovery.TokenEndpointField);
        const jwks = OidcDiscovery.RequiredString(doc, OidcDiscovery.JwksUriField);
        OidcDiscovery.RequireHttps(issuer);
        OidcDiscovery.RequireHttps(authorization);
        OidcDiscovery.RequireHttps(token);
        OidcDiscovery.RequireHttps(jwks);

        const value = new OidcEndpoints(issuer, authorization, token, jwks, OidcDiscovery.StringList(doc, OidcDiscovery.PromptValuesField),
            OidcDiscovery.OptionalHttps(doc, OidcDiscovery.EndSessionEndpointField));
        this.cache.set(discoveryUrl, { value, expiresAt: this.now().getTime() + OidcDiscovery.TtlMs });
        return value;
    }

    private static RequiredString(doc: Record<string, unknown> | null, field: string): string
    {
        const v = doc?.[field];
        if (typeof v !== "string" || v.length === 0)
        {
            throw new Error(OidcDiscovery.InvalidDocumentError);
        }
        return v;
    }

    /** An optional array of strings; its non-string entries are dropped, and anything else reads as empty. */
    private static StringList(doc: Record<string, unknown> | null, field: string): readonly string[]
    {
        const v = doc?.[field];
        return Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === "string") : [];
    }

    /** An optional https URL; anything else (absent, not a string, not an https URL) reads as undefined, so an
     *  optional endpoint the issuer gets wrong never takes sign-in down with it. */
    private static OptionalHttps(doc: Record<string, unknown> | null, field: string): string | undefined
    {
        const v = doc?.[field];
        return typeof v === "string" && OidcDiscovery.IsHttps(v) ? v : undefined;
    }

    private static IsHttps(url: string): boolean
    {
        try
        {
            return new URL(url).protocol === OidcDiscovery.HttpsProtocol;
        }
        catch
        {
            return false;
        }
    }

    private static RequireHttps(url: string): void
    {
        if (!OidcDiscovery.IsHttps(url))
        {
            throw new Error(OidcDiscovery.InsecureEndpointError);
        }
    }
}
