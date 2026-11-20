import { Principal, PrincipalKind } from "@pragmatic-tech-ai/pragmatic-identity";
import type { Realm } from "@pragmatic-tech-ai/pragmatic-identity";
import type { IdentityPlatformToken } from "../token/identity-platform-token.js";

/**
 * Maps a verified Identity Platform token to the realm account: subject = the Identity Platform uid (stable across
 * email changes and providers), claims email, name, email_verified and sign_in_provider. Identity Platform carries no
 * groups; the realm's role mapping assigns roles to particular accounts.
 */
export class IdentityPlatformAccountMapper
{
    public static readonly EmailClaim = "email";
    public static readonly NameClaim = "name";
    public static readonly EmailVerifiedClaim = "email_verified";
    public static readonly SignInProviderClaim = "sign_in_provider";

    public Map(token: IdentityPlatformToken, realm: Realm): Principal
    {
        const claims = new Map<string, string>();
        if (token.Email !== null)
        {
            claims.set(IdentityPlatformAccountMapper.EmailClaim, token.Email);
        }
        if (token.DisplayName !== null)
        {
            claims.set(IdentityPlatformAccountMapper.NameClaim, token.DisplayName);
        }
        claims.set(IdentityPlatformAccountMapper.EmailVerifiedClaim, String(token.EmailVerified));
        claims.set(IdentityPlatformAccountMapper.SignInProviderClaim, token.SignInProvider);
        return new Principal(token.Uid, realm.Id, PrincipalKind.User, claims, []);
    }
}
