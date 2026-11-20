export class OidcFlowState
{
    public constructor(
        public readonly State: string,
        public readonly Nonce: string,
        public readonly CodeVerifier: string,
        public readonly RedirectUri: string,
        public readonly ExpiresAt: Date,
        /** The application's validated, same-origin path to land on once the sign-in completes; null for its default.
         *  The authenticator only carries it: validating it is the application's (OidcLoginEndpoint's) job. */
        public readonly ReturnPath: string | null = null)
    {
    }
}
