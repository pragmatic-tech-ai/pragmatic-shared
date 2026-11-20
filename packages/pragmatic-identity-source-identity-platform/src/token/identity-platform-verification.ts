import type { IdentityPlatformRejection } from "./identity-platform-rejection.js";
import type { IdentityPlatformToken } from "./identity-platform-token.js";

/** The outcome of verifying an ID token: the token, or why it was refused. */
export class IdentityPlatformVerification
{
    private constructor(
        public readonly Token: IdentityPlatformToken | null,
        public readonly Rejection: IdentityPlatformRejection | null)
    {
    }

    public get IsVerified(): boolean
    {
        return this.Token !== null;
    }

    public static Verified(token: IdentityPlatformToken): IdentityPlatformVerification
    {
        return new IdentityPlatformVerification(token, null);
    }

    public static Rejected(rejection: IdentityPlatformRejection): IdentityPlatformVerification
    {
        return new IdentityPlatformVerification(null, rejection);
    }
}
