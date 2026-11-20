/** A non-2xx answer from the application's host. `message` is the server's `error` text (the `ProblemMapper` shape). */
export class ApiError extends Error
{
    public static readonly UnauthorizedStatus = 401
    public static readonly ForbiddenStatus = 403
    public static readonly NotFoundStatus = 404
    public static readonly ConflictStatus = 409
    public static readonly TooManyRequestsStatus = 429
    public static readonly UnavailableStatus = 503

    private static readonly ErrorName = 'ApiError'

    public readonly Status: number
    /** The server's machine-readable error code, when it sends one. */
    public readonly Code: string | undefined
    /** The whole error body (application fields beyond `error` and `code`); undefined when it was not JSON. */
    public readonly Body: Readonly<Record<string, unknown>> | undefined

    public constructor(status: number, message: string, code?: string, body?: Readonly<Record<string, unknown>>)
    {
        super(message)
        this.name = ApiError.ErrorName
        this.Status = status
        this.Code = code
        this.Body = body
    }

    /** The session is gone (or never was): the shell goes back to sign-in. */
    public get IsUnauthorized(): boolean
    {
        return this.Status === ApiError.UnauthorizedStatus
    }

    /** Signed in, but the session's roles do not allow it (or the request came from another origin). */
    public get IsForbidden(): boolean
    {
        return this.Status === ApiError.ForbiddenStatus
    }

    public static Is(error: unknown, status: number): boolean
    {
        return error instanceof ApiError && error.Status === status
    }
}
