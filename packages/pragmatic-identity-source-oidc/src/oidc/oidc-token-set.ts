/**
 * The upstream tokens of one sign-in (or one refresh) that a relying party needs for downstream calls: the verified ID
 * token, the access and refresh tokens when the issuer gave them, and when they fall due. ExpiresAt is the earlier of
 * the ID token's expiry and the access token's (`expires_in`). The tokens are secrets: never logged or echoed.
 */
export class OidcTokenSet
{
    public constructor(
        public readonly Subject: string,
        public readonly IdToken: string,
        public readonly IdTokenExpiresAt: Date,
        public readonly AccessToken: string | null,
        public readonly AccessTokenExpiresAt: Date | null,
        public readonly RefreshToken: string | null)
    {
    }

    /** When the set falls due: the earlier of the two expiries. */
    public get ExpiresAt(): Date
    {
        const access = this.AccessTokenExpiresAt;
        return access !== null && access.getTime() < this.IdTokenExpiresAt.getTime() ? access : this.IdTokenExpiresAt;
    }

    /** Whether the issuer gave a refresh token, so the set can be renewed rather than the sign-in ending. */
    public get Refreshable(): boolean
    {
        return this.RefreshToken !== null;
    }
}

/** A sign-in's result and, when it succeeded, its upstream tokens and the return path its flow was begun with. */
export class OidcSignInOutcome<TResult>
{
    public constructor(public readonly Result: TResult, public readonly Tokens: OidcTokenSet | null, public readonly ReturnPath: string | null = null)
    {
    }
}
