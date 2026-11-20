import { createLocalJWKSet } from "jose";
import type { JSONWebKeySet } from "jose";
import type { IHttpClient } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";

export type IdentityPlatformKeyResolver = ReturnType<typeof createLocalJWKSet>;

/**
 * Google's securetoken signing keys (the JWK form of the endpoint), cached. Google rotates them every few hours and
 * publishes the next key ahead of use, so the cache lives an hour; an unknown key id forces a refetch, at most once a
 * minute (an attacker's made-up kid cannot make us hammer Google). A failed fetch is not cached.
 */
export class IdentityPlatformKeySet
{
    public static readonly SecuretokenJwksUri = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

    private static readonly DefaultTtlMs = 3_600_000;
    private static readonly DefaultMinRefreshMs = 60_000;

    private resolver: IdentityPlatformKeyResolver | null = null;
    private fetchedAt = 0;
    private forcedAt = Number.NEGATIVE_INFINITY;

    public constructor(
        private readonly http: IHttpClient,
        private readonly now: () => Date = () => new Date(),
        private readonly ttlMs: number = IdentityPlatformKeySet.DefaultTtlMs,
        private readonly minRefreshMs: number = IdentityPlatformKeySet.DefaultMinRefreshMs)
    {
    }

    /** The cached keys, fetched when absent or older than the time to live. Throws when they cannot be fetched. */
    public async Current(): Promise<IdentityPlatformKeyResolver>
    {
        if (this.resolver !== null && this.Age() < this.ttlMs)
        {
            return this.resolver;
        }
        return this.Fetch();
    }

    /** Refetches after an unknown key id; null when the last such refetch is too recent to try again. */
    public async RefreshForUnknownKey(): Promise<IdentityPlatformKeyResolver | null>
    {
        const at = this.now().getTime();
        if (at - this.forcedAt < this.minRefreshMs)
        {
            return null;
        }
        this.forcedAt = at;
        return this.Fetch();
    }

    private Age(): number
    {
        return this.now().getTime() - this.fetchedAt;
    }

    private async Fetch(): Promise<IdentityPlatformKeyResolver>
    {
        const jwks = await this.http.GetJson(IdentityPlatformKeySet.SecuretokenJwksUri) as JSONWebKeySet;
        this.resolver = createLocalJWKSet(jwks);
        this.fetchedAt = this.now().getTime();
        return this.resolver;
    }
}
