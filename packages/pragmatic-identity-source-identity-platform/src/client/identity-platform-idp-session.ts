import { IdentityPlatformSession } from "./identity-platform-session.js";

/**
 * A session signed in through an upstream provider (accounts:signInWithIdp): the session plus what the provider
 * asserted. EmailVerified is the provider's word (Google's accounts arrive verified); IsNewUser is true when the sign-in
 * created the Identity Platform account.
 */
export class IdentityPlatformIdpSession extends IdentityPlatformSession
{
    public constructor(
        uid: string,
        email: string,
        idToken: string,
        refreshToken: string,
        expiresInSeconds: number,
        public readonly ProviderId: string,
        public readonly EmailVerified: boolean,
        public readonly DisplayName: string | null,
        public readonly IsNewUser: boolean)
    {
        super(uid, email, idToken, refreshToken, expiresInSeconds);
    }
}
