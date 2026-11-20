/** An Identity Platform account as accounts:lookup reports it. */
export class IdentityPlatformUser
{
    public constructor(
        public readonly Uid: string,
        public readonly Email: string | null,
        public readonly EmailVerified: boolean,
        public readonly DisplayName: string | null,
        public readonly Providers: readonly string[],
        public readonly Disabled: boolean)
    {
    }
}
