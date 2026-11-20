/** A verified Identity Platform ID token, read into typed fields. */
export class IdentityPlatformToken
{
    public constructor(
        /** The Identity Platform uid (the `sub` claim): the realm account's subject. */
        public readonly Uid: string,
        public readonly Email: string | null,
        public readonly EmailVerified: boolean,
        public readonly DisplayName: string | null,
        /** `firebase.sign_in_provider`: `password`, `google.com`, ... */
        public readonly SignInProvider: string,
        public readonly TenantId: string | null,
        public readonly AuthTime: Date,
        public readonly IssuedAt: Date,
        public readonly ExpiresAt: Date)
    {
    }
}
