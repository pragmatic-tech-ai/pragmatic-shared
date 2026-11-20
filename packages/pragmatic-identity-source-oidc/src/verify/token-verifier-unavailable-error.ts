/**
 * The verifier cannot decide: the issuer's discovery document or its keys could not be fetched or are not usable
 * (another issuer, no https key set). A fixed sentence plus the reason; never the token.
 */
export class TokenVerifierUnavailableError extends Error
{
    private static readonly ErrorName = "TokenVerifierUnavailableError";
    private static readonly Prefix = "token verifier unavailable: ";

    public constructor(reason: string)
    {
        super(TokenVerifierUnavailableError.Prefix + reason);
        this.name = TokenVerifierUnavailableError.ErrorName;
    }
}
