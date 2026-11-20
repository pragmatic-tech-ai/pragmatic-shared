export class OidcResolvedConfig
{
    public constructor(
        public readonly DiscoveryUrl: string,
        public readonly Issuer: string,
        public readonly ClientId: string,
        public readonly RedirectUri: string,
        public readonly Scopes: readonly string[],
        public readonly SecretRef: string | null,
        public readonly ClientSecretParam: string,
        /** Claims the ID token must carry besides the ones always checked (e.g. `iat`, `email`); default none. */
        public readonly RequiredClaims: readonly string[] = [])
    {
    }
}
