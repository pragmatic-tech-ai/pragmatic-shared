/** A signed-in Identity Platform session (accounts:signUp / accounts:signInWithPassword). */
export class IdentityPlatformSession
{
    public constructor(
        public readonly Uid: string,
        public readonly Email: string,
        public readonly IdToken: string,
        public readonly RefreshToken: string,
        public readonly ExpiresInSeconds: number)
    {
    }
}
