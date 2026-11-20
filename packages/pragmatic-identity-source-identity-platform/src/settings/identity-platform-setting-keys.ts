/** The provider settings (IdentityConfig.ProviderSettings) of the Identity Platform source. */
export class IdentityPlatformSettingKeys
{
    /** Required: the Google Cloud project id (issuer suffix and token audience). */
    public static readonly ProjectId = "projectId";
    /** Required: secret reference to the browser API key the login page uses. */
    public static readonly ApiKeyRef = "apiKeyRef";
    /** Comma-separated Identity Platform provider ids the realm accepts; default `password`. */
    public static readonly Providers = "providers";
    /** The Identity Platform tenant (multi-tenancy); absent: the project-level pool only. */
    public static readonly TenantId = "tenantId";
    /** How old a sign-in (auth_time) may be when its token is posted; default 600 seconds. */
    public static readonly MaxAuthAgeSeconds = "maxAuthAgeSeconds";
    /** The auth domain for the client SDK's popup flows; default `<projectId>.firebaseapp.com`. */
    public static readonly AuthDomain = "authDomain";
}
