import { RealmRoleClaims } from '@pragmatic-tech-ai/pragmatic-identity'
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
    /** Tenant roles (`admin`), checked against the session's `roles` claim. */
    Role?: string | readonly string[]
    /** This application's roles (`finance`), checked against the session's `app_roles` claim. */
    AppRole?: string | readonly string[]
}

/**
 * Authorization from the claims the realm issued (RealmRoleClaims): a route names the tenant roles (Role) and/or this
 * application's roles (AppRole) it admits, and the session must hold one of them: a tenant role in its `roles` claim,
 * an application role in its `app_roles` claim (the relying party keeps there only this application's roles, by bare
 * name). Any one named role suffices. A read that names no role is open to any session; a mutation that names none is
 * DENIED (deny by default), unless it names AnySignedIn.
 */
export class ClaimsAuthorizer
{
    /** The role that opens a route to every signed-in subject (sign-out, the subject's own password). */
    public static readonly AnySignedIn = '*'

    public constructor(
        public readonly RoleClaim: string = RealmRoleClaims.RolesClaim,
        public readonly AppRoleClaim: string = RealmRoleClaims.AppRolesClaim,
    )
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
        const tenantRoles = ClaimsAuthorizer.Listed(route.Role)
        const appRoles = ClaimsAuthorizer.Listed(route.AppRole)
        if (tenantRoles.length === 0 && appRoles.length === 0)
        {
            return HttpMethods.IsMutating(route.Method) ? AuthorizationOutcome.Forbidden : AuthorizationOutcome.Allowed
        }
        if (tenantRoles.includes(ClaimsAuthorizer.AnySignedIn))
        {
            return AuthorizationOutcome.Allowed
        }
        const heldTenant = session.Claims.Values(this.RoleClaim)
        const heldApp = session.Claims.Values(this.AppRoleClaim)
        const allowed = tenantRoles.some(role => heldTenant.includes(role)) || appRoles.some(role => role !== ClaimsAuthorizer.AnySignedIn && heldApp.includes(role))
        return allowed ? AuthorizationOutcome.Allowed : AuthorizationOutcome.Forbidden
    }

    private static Listed(roles: string | readonly string[] | undefined): readonly string[]
    {
        return roles === undefined ? [] : typeof roles === 'string' ? [roles] : roles
    }
}
