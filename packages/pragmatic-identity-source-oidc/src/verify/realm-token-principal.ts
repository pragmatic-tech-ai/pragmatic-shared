import { RealmRoleClaims } from "@pragmatic-tech-ai/pragmatic-identity";

/**
 * Who a verified realm token is for: the issuer and subject identify the account; the email is informational (it can
 * change) and EmailVerified is true only for `email_verified: true`; the roles are the realm's role claims as
 * RealmRoleClaims reads them (`roles`, `app_roles`). Claims holds the whole verified payload, read-only.
 */
export class RealmTokenPrincipal
{
    private static readonly EmailClaim = "email";
    private static readonly EmailVerifiedClaim = "email_verified";
    private static readonly AuthorizedPartyClaim = "azp";
    private static readonly AudienceClaim = "aud";

    public readonly Email: string | undefined;
    public readonly EmailVerified: boolean;
    public readonly AuthorizedParty: string | undefined;
    public readonly Audience: readonly string[];
    public readonly Roles: RealmRoleClaims;
    public readonly Claims: Readonly<Record<string, unknown>>;

    public constructor(public readonly Issuer: string, public readonly Subject: string, payload: Record<string, unknown>)
    {
        const P = RealmTokenPrincipal;
        const email = payload[P.EmailClaim];
        const azp = payload[P.AuthorizedPartyClaim];
        const aud = payload[P.AudienceClaim];
        this.Email = typeof email === "string" ? email : undefined;
        this.EmailVerified = this.Email !== undefined && payload[P.EmailVerifiedClaim] === true;
        this.AuthorizedParty = typeof azp === "string" ? azp : undefined;
        this.Audience = Object.freeze(typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : []);
        this.Roles = RealmRoleClaims.FromPayload(payload);
        this.Claims = Object.freeze({ ...payload });
        Object.freeze(this);
    }
}
