import { ClaimArrayGroupStrategy, OidcProviderProfile, OidcSettingKeys } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";

/**
 * "Sign in with Pragmatic": the central realm's OIDC face (the realm sign-in service at login.pragmatic-tech.ai) as an
 * upstream of another realm. A generic-OIDC profile with the issuer preset; the `issuer` setting overrides it for
 * tests and development stacks. Groups come from the central realm's `roles` claim (array of strings).
 */
export class PragmaticIdentityProfile extends OidcProviderProfile
{
    public static readonly CentralIssuer = "https://login.pragmatic-tech.ai/realms/central";

    private static readonly Scopes: readonly string[] = ["openid", "profile", "email"];
    private static readonly EmailClaim = "email";
    private static readonly NameClaim = "name";
    private static readonly RolesClaim = "roles";
    private static readonly SecretParam = "client_secret";
    private static readonly WellKnownSuffix = "/.well-known/openid-configuration";
    private static readonly TrailingSlashes = /\/+$/;

    public constructor()
    {
        super(
            PragmaticIdentityProfile.Scopes,
            new Map([
                [PragmaticIdentityProfile.EmailClaim, PragmaticIdentityProfile.EmailClaim],
                [PragmaticIdentityProfile.NameClaim, PragmaticIdentityProfile.NameClaim],
            ]),
            new ClaimArrayGroupStrategy(PragmaticIdentityProfile.RolesClaim),
            PragmaticIdentityProfile.SecretParam);
    }

    public override ResolveIssuer(settings: ReadonlyMap<string, string>): string
    {
        const value = settings.get(OidcSettingKeys.Issuer);
        if (value === undefined || value === "")
        {
            return PragmaticIdentityProfile.CentralIssuer;
        }
        return value.replace(PragmaticIdentityProfile.TrailingSlashes, "");
    }

    public override ResolveDiscoveryUrl(settings: ReadonlyMap<string, string>): string
    {
        return this.ResolveIssuer(settings) + PragmaticIdentityProfile.WellKnownSuffix;
    }
}
