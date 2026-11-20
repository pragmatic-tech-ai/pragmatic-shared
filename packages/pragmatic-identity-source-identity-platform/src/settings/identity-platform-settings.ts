import { IdentityPlatformProvider } from "../client/identity-platform-provider.js";
import { IdentityPlatformSettingKeys } from "./identity-platform-setting-keys.js";

/** The Identity Platform source's settings, read and checked from the realm's provider settings. */
export class IdentityPlatformSettings
{
    public static readonly IssuerPrefix = "https://securetoken.google.com/";

    private static readonly DefaultMaxAuthAgeSeconds = 600;
    private static readonly AuthDomainSuffix = ".firebaseapp.com";
    private static readonly ProviderSeparator = ",";
    private static readonly RequiredPrefix = "Identity Platform setting is required: ";
    private static readonly InvalidPrefix = "Identity Platform setting is invalid: ";

    private constructor(
        public readonly ProjectId: string,
        public readonly ApiKeyRef: string,
        public readonly Providers: readonly IdentityPlatformProvider[],
        public readonly TenantId: string | null,
        public readonly MaxAuthAgeSeconds: number,
        public readonly AuthDomain: string)
    {
    }

    /** The ID tokens' issuer: https://securetoken.google.com/<projectId>. */
    public get Issuer(): string
    {
        return IdentityPlatformSettings.IssuerPrefix + this.ProjectId;
    }

    public static From(settings: ReadonlyMap<string, string>): IdentityPlatformSettings
    {
        const projectId = IdentityPlatformSettings.Require(settings, IdentityPlatformSettingKeys.ProjectId);
        return new IdentityPlatformSettings(
            projectId,
            IdentityPlatformSettings.Require(settings, IdentityPlatformSettingKeys.ApiKeyRef),
            IdentityPlatformSettings.ProvidersFrom(settings.get(IdentityPlatformSettingKeys.Providers)),
            IdentityPlatformSettings.Optional(settings, IdentityPlatformSettingKeys.TenantId),
            IdentityPlatformSettings.MaxAgeFrom(settings.get(IdentityPlatformSettingKeys.MaxAuthAgeSeconds)),
            IdentityPlatformSettings.Optional(settings, IdentityPlatformSettingKeys.AuthDomain) ?? projectId + IdentityPlatformSettings.AuthDomainSuffix);
    }

    public Enables(provider: string): boolean
    {
        return (this.Providers as readonly string[]).includes(provider);
    }

    private static ProvidersFrom(value: string | undefined): IdentityPlatformProvider[]
    {
        if (value === undefined || value.trim() === "")
        {
            return [IdentityPlatformProvider.Password];
        }
        const known = Object.values(IdentityPlatformProvider) as string[];
        const providers: IdentityPlatformProvider[] = [];
        for (const raw of value.split(IdentityPlatformSettings.ProviderSeparator))
        {
            const id = raw.trim();
            if (!known.includes(id))
            {
                throw new Error(IdentityPlatformSettings.InvalidPrefix + IdentityPlatformSettingKeys.Providers);
            }
            providers.push(id as IdentityPlatformProvider);
        }
        return providers;
    }

    private static MaxAgeFrom(value: string | undefined): number
    {
        if (value === undefined || value === "")
        {
            return IdentityPlatformSettings.DefaultMaxAuthAgeSeconds;
        }
        const seconds = Number(value);
        if (!Number.isInteger(seconds) || seconds <= 0)
        {
            throw new Error(IdentityPlatformSettings.InvalidPrefix + IdentityPlatformSettingKeys.MaxAuthAgeSeconds);
        }
        return seconds;
    }

    private static Require(settings: ReadonlyMap<string, string>, key: string): string
    {
        const value = IdentityPlatformSettings.Optional(settings, key);
        if (value === null)
        {
            throw new Error(IdentityPlatformSettings.RequiredPrefix + key);
        }
        return value;
    }

    private static Optional(settings: ReadonlyMap<string, string>, key: string): string | null
    {
        const value = settings.get(key)?.trim();
        return value === undefined || value === "" ? null : value;
    }
}
