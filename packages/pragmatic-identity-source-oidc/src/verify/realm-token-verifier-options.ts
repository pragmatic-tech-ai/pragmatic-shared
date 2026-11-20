import type { IHttpClient } from "../http/http-client.js";

/** What a realm token must satisfy, and where the issuer's keys come from. */
export interface RealmTokenVerifierOptions
{
    /** The issuer the token must carry, exactly (e.g. `https://login.pragmatic-tech.ai/realms/central`). */
    Issuer: string;
    /** The audience the token must carry: one of these in `aud` (the relying party's client id). */
    Audience: string | readonly string[];
    /** When set, `azp` must be present and one of these. Absent: `azp` is not checked. */
    AuthorizedParties?: readonly string[];
    /** Default `<issuer without trailing slashes>/.well-known/openid-configuration`; https only. */
    DiscoveryUrl?: string;
    /** The HTTP client for discovery and keys; default from CaBundleFile (fetch when absent). */
    Http?: IHttpClient;
    /** A PEM CA bundle (mounted secret or config file) trusted, besides the public roots, for discovery and keys: a
     *  realm on a private CA. Ignored when Http is given. */
    CaBundleFile?: string;
    /** Signature algorithms accepted; default RS256 and ES256. Symmetric and `none` are never accepted. */
    Algorithms?: readonly string[];
    /** Tolerance for exp, nbf and iat; default 60 s. */
    ClockSkewSeconds?: number;
    /** Claims that must be present besides iss, sub, aud, exp and iat. */
    RequiredClaims?: readonly string[];
    /** The token must carry a string `email`. Default false. */
    RequireEmail?: boolean;
    /** The token must carry a string `email` with `email_verified: true`. Default false. */
    RequireVerifiedEmail?: boolean;
    /** How long the issuer's discovery document is kept; default 300 s. */
    DiscoveryTtlSeconds?: number;
    /** How long a fetched key set is kept before it is fetched again; default 3600 s. */
    KeysTtlSeconds?: number;
    /** An unknown key id refetches the keys at most this often (rotation without a fetch storm); default 60 s. */
    MinKeyRefreshSeconds?: number;
    /** The clock (tests). */
    Now?: () => Date;
}
