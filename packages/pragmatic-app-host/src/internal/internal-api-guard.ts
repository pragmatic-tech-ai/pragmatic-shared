import { HttpProblem } from '../http/http-problem.js'
import type { RequestContext } from '../routing/request-context.js'
import type { InternalApiCredential } from './internal-api-credential.js'

/** The route-side check of an internal link: the request's `authorization` header must carry the link's bearer, else
 *  a 401 with code `unauthorized`. Mounted on RouteAuth.Public routes (the caller is a service, not a session). */
export class InternalApiGuard
{
    public static readonly UnauthorizedCode = 'unauthorized'
    private static readonly StatusUnauthorized = 401
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly UnauthorizedMessage = 'Unauthorized'

    public constructor(private readonly credential: InternalApiCredential)
    {
    }

    public Allows(context: RequestContext): boolean
    {
        const header = context.Request.headers[InternalApiGuard.AuthorizationHeader]
        return this.credential.MatchesAuthorization(typeof header === 'string' ? header : undefined)
    }

    public Require(context: RequestContext): void
    {
        if (!this.Allows(context))
        {
            throw new HttpProblem(InternalApiGuard.StatusUnauthorized, InternalApiGuard.UnauthorizedMessage, InternalApiGuard.UnauthorizedCode)
        }
    }
}
