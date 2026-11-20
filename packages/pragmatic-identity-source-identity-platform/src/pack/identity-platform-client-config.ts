import type { ISecretStore } from "@pragmatic-tech-ai/pragmatic-identity";
import { IdentityPlatformPageConfig } from "../client/identity-platform-page-config.js";
import type { IdentityPlatformProvider } from "../client/identity-platform-provider.js";
import type { IdentityPlatformSettings } from "../settings/identity-platform-settings.js";

/**
 * What the login page needs from this source, as configured: project id, the API key as a secret reference, the auth
 * domain, the enabled providers and the Identity Platform tenant. Resolve reads the key from the realm's secrets home
 * and gives the page config the sign-in service embeds in the login page.
 */
export class IdentityPlatformClientConfig
{
    private static readonly MissingKeyMessage = "Identity Platform API key secret is missing: ";

    public constructor(
        public readonly ProjectId: string,
        public readonly ApiKeyRef: string,
        public readonly AuthDomain: string,
        public readonly Providers: readonly IdentityPlatformProvider[],
        public readonly TenantId: string | null)
    {
    }

    public static From(settings: IdentityPlatformSettings): IdentityPlatformClientConfig
    {
        return new IdentityPlatformClientConfig(settings.ProjectId, settings.ApiKeyRef, settings.AuthDomain, settings.Providers, settings.TenantId);
    }

    public async Resolve(secrets: ISecretStore): Promise<IdentityPlatformPageConfig>
    {
        const apiKey = await secrets.Get(this.ApiKeyRef);
        if (apiKey === null || apiKey === "")
        {
            throw new Error(IdentityPlatformClientConfig.MissingKeyMessage + this.ApiKeyRef);
        }
        return new IdentityPlatformPageConfig(this.ProjectId, apiKey, this.AuthDomain, this.Providers, this.TenantId);
    }
}
