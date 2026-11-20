/**
 * The single failure every OIDC sign-in path collapses to. Its message is a fixed, generic sentence: the client secret,
 * the authorization code and any inner error text are never part of it. Callers learn only that the sign-in failed.
 */
export class OidcLoginError extends Error
{
    private static readonly ErrorName = 'OidcLoginError'
    private static readonly GenericMessage = 'Sign-in failed'

    public constructor()
    {
        super(OidcLoginError.GenericMessage)
        this.name = OidcLoginError.ErrorName
    }

    /** Any failure as a generic OidcLoginError, the original dropped so nothing can leak. */
    public static From(err: unknown): OidcLoginError
    {
        return err instanceof OidcLoginError ? err : new OidcLoginError()
    }
}
