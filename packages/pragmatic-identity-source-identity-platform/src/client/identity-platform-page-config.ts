import { IdentityPlatformProvider } from "./identity-platform-provider.js";

/** The page config as JSON (embedded in the login page by the realm sign-in service). */
export interface IdentityPlatformPageConfigJson
{
    projectId: string;
    apiKey: string;
    authDomain: string;
    providers: string[];
    tenantId: string | null;
}

/**
 * What the login page needs to drive Identity Platform: the project, the browser API key (public by design, restricted
 * to the login page's referrer and the Identity Toolkit / Secure Token APIs), the auth domain (for a future SDK popup
 * flow), the enabled providers and the Identity Platform tenant, if any. Built server-side by
 * IdentityPlatformClientConfig.Resolve; browser-safe.
 */
export class IdentityPlatformPageConfig
{
    private static readonly InvalidMessage = "invalid Identity Platform page config";
    private static readonly StringType = "string";

    public constructor(
        public readonly ProjectId: string,
        public readonly ApiKey: string,
        public readonly AuthDomain: string,
        public readonly Providers: readonly IdentityPlatformProvider[],
        public readonly TenantId: string | null)
    {
    }

    public static FromJson(json: unknown): IdentityPlatformPageConfig
    {
        const value = json as Partial<IdentityPlatformPageConfigJson> | null;
        const known = Object.values(IdentityPlatformProvider) as string[];
        if (value === null
            || typeof value !== "object"
            || typeof value.projectId !== IdentityPlatformPageConfig.StringType
            || typeof value.apiKey !== IdentityPlatformPageConfig.StringType
            || typeof value.authDomain !== IdentityPlatformPageConfig.StringType
            || !Array.isArray(value.providers)
            || !value.providers.every(provider => known.includes(provider))
            || (value.tenantId !== null && typeof value.tenantId !== IdentityPlatformPageConfig.StringType))
        {
            throw new Error(IdentityPlatformPageConfig.InvalidMessage);
        }
        return new IdentityPlatformPageConfig(value.projectId!, value.apiKey!, value.authDomain!, value.providers as IdentityPlatformProvider[], value.tenantId ?? null);
    }

    public Enables(provider: IdentityPlatformProvider): boolean
    {
        return this.Providers.includes(provider);
    }

    public ToJson(): IdentityPlatformPageConfigJson
    {
        return { projectId: this.ProjectId, apiKey: this.ApiKey, authDomain: this.AuthDomain, providers: [...this.Providers], tenantId: this.TenantId };
    }
}
