export class OidcEndpoints
{
    public constructor(
        public readonly Issuer: string,
        public readonly AuthorizationEndpoint: string,
        public readonly TokenEndpoint: string,
        public readonly JwksUri: string,
        /** `prompt_values_supported` (OIDC Initiating User Registration adds `create`); empty when not advertised. */
        public readonly PromptValues: readonly string[] = [])
    {
    }
}
