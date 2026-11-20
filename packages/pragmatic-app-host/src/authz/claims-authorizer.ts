import { HttpMethods } from '../http/http-method.js'
import type { HttpMethod } from '../http/http-method.js'
import { RouteAuth } from '../routing/route.js'
import type { SessionRecord } from '../session/session-record.js'

/** What the authorization step decided. */
export enum AuthorizationOutcome
{
    Allowed = 'allowed',
    /** No session where one is needed: 401. */
    Unauthenticated = 'unauthenticated',
    /** A session without the route's role, or a mutation that names no role: 403. */
    Forbidden = 'forbidden',
}

/** The parts of a route the authorizer reads. */
export interface IAuthorizedRoute
{
    Method: HttpMethod
    Auth: RouteAuth
    Role?: string | readonly string[]
}

/**
 * Authorization from claims: a route names the role it needs and the session's role claim (tenant roles and
 * application roles, as the realm issued them) must hold it, or one of them when several are named. A read that names
 * no role is open to any session; a mutation that names none is DENIED (deny by default), unless it names AnySignedIn.
 */
export class ClaimsAuthorizer
{
    /** The role that opens a route to every signed-in subject (sign-out, the subject's own password). */
    public static readonly AnySignedIn = '*'
    private static readonly DefaultRoleClaim = 'roles'

    public constructor(public readonly RoleClaim: string = ClaimsAuthorizer.DefaultRoleClaim)
    {
    }

    public Authorize(route: IAuthorizedRoute, session: SessionRecord | null): AuthorizationOutcome
    {
        if (route.Auth === RouteAuth.Public)
        {
            return AuthorizationOutcome.Allowed
        }
        if (session === null)
        {
            return AuthorizationOutcome.Unauthenticated
        }
        const roles = route.Role === undefined ? [] : typeof route.Role === 'string' ? [route.Role] : route.Role
        if (roles.length === 0)
        {
            return HttpMethods.IsMutating(route.Method) ? AuthorizationOutcome.Forbidden : AuthorizationOutcome.Allowed
        }
        if (roles.includes(ClaimsAuthorizer.AnySignedIn))
        {
            return AuthorizationOutcome.Allowed
        }
        const held = session.Claims.Values(this.RoleClaim)
        return roles.some(role => held.includes(role)) ? AuthorizationOutcome.Allowed : AuthorizationOutcome.Forbidden
    }
}
