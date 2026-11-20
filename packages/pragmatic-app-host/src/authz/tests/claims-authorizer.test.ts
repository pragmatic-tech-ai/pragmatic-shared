import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RealmRoleClaims } from '@pragmatic-tech-ai/pragmatic-identity'
import { AuthorizationOutcome, ClaimsAuthorizer } from '../claims-authorizer.js'
import { RouteAuth } from '../../routing/route.js'
import type { RouteDefinition } from '../../routing/route.js'
import { HttpMethod } from '../../http/http-method.js'
import { SessionRecord } from '../../session/session-record.js'
import { SessionClaims } from '../../session/session-claims.js'
import { SessionPolicy } from '../../session/session-policy.js'

class Fixture
{
    public static Route(method: HttpMethod, auth: RouteAuth, role?: string | readonly string[]): RouteDefinition
    {
        return { Method: method, Pattern: '/api/x', Auth: auth, Role: role, Handler: async () => undefined }
    }

    public static AppRoute(method: HttpMethod, role: string | readonly string[] | undefined, appRole: string | readonly string[] | undefined): RouteDefinition
    {
        return { Method: method, Pattern: '/api/x', Auth: RouteAuth.Session, Role: role, AppRole: appRole, Handler: async () => undefined }
    }

    public static Session(claims: Record<string, string | readonly string[]>): SessionRecord
    {
        const now = new Date()
        return new SessionRecord('id', 'alice', SessionClaims.From(claims), now, new Date(now.getTime() + 1000), now, new SessionPolicy(1000))
    }
}

test('a public route is allowed with or without a session', () =>
{
    const authorizer = new ClaimsAuthorizer()
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Post, RouteAuth.Public), null), AuthorizationOutcome.Allowed)
})

test('a session route without a session is unauthenticated', () =>
{
    const authorizer = new ClaimsAuthorizer()
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Get, RouteAuth.Session), null), AuthorizationOutcome.Unauthenticated)
})

test('a read without a role is open to any session; a mutation without a role is denied by default', () =>
{
    const authorizer = new ClaimsAuthorizer()
    const session = Fixture.Session({ roles: ['app.admin'] })
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Get, RouteAuth.Session), session), AuthorizationOutcome.Allowed)
    for (const method of [HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete])
    {
        assert.equal(authorizer.Authorize(Fixture.Route(method, RouteAuth.Session), session), AuthorizationOutcome.Forbidden, method)
    }
})

test('a mutation open to every signed-in subject says so explicitly', () =>
{
    const authorizer = new ClaimsAuthorizer()
    const route = Fixture.Route(HttpMethod.Post, RouteAuth.Session, ClaimsAuthorizer.AnySignedIn)
    assert.equal(authorizer.Authorize(route, Fixture.Session({})), AuthorizationOutcome.Allowed)
})

test('a route role is matched against the session\'s role claim; any one of several roles suffices', () =>
{
    const authorizer = new ClaimsAuthorizer()
    const admin = Fixture.Session({ roles: ['tenant.admin'] })
    const reader = Fixture.Session({ roles: ['tenant.reader'] })
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Post, RouteAuth.Session, 'tenant.admin'), admin), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Post, RouteAuth.Session, 'tenant.admin'), reader), AuthorizationOutcome.Forbidden)
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Get, RouteAuth.Session, 'tenant.admin'), reader), AuthorizationOutcome.Forbidden)
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Get, RouteAuth.Session, ['tenant.admin', 'tenant.reader']), reader), AuthorizationOutcome.Allowed)
})

test('the role claim name is configurable', () =>
{
    const authorizer = new ClaimsAuthorizer('app_roles')
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Post, RouteAuth.Session, 'x'), Fixture.Session({ app_roles: ['x'] })), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(Fixture.Route(HttpMethod.Post, RouteAuth.Session, 'x'), Fixture.Session({ roles: ['x'] })), AuthorizationOutcome.Forbidden)
})

test('by default the authorizer reads the realm role claims: tenant roles from roles, application roles from app_roles', () =>
{
    const authorizer = new ClaimsAuthorizer()
    assert.equal(authorizer.RoleClaim, RealmRoleClaims.RolesClaim)
    assert.equal(authorizer.AppRoleClaim, RealmRoleClaims.AppRolesClaim)
    const finance = Fixture.Session({ roles: [], app_roles: ['finance'] })
    const admin = Fixture.Session({ roles: ['admin'] })
    const route = Fixture.AppRoute(HttpMethod.Post, 'admin', 'finance')
    assert.equal(authorizer.Authorize(route, finance), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(route, admin), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(route, Fixture.Session({ roles: ['finance'], app_roles: ['admin'] })), AuthorizationOutcome.Forbidden)
})

test('an application-role-only route admits only a holder of one of its application roles; reads included', () =>
{
    const authorizer = new ClaimsAuthorizer()
    const route = Fixture.AppRoute(HttpMethod.Get, undefined, ['finance', 'sales'])
    assert.equal(authorizer.Authorize(route, Fixture.Session({ app_roles: ['sales'] })), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(route, Fixture.Session({ roles: ['admin'] })), AuthorizationOutcome.Forbidden)
    assert.equal(authorizer.Authorize(route, Fixture.Session({})), AuthorizationOutcome.Forbidden)
    assert.equal(authorizer.Authorize(route, null), AuthorizationOutcome.Unauthenticated)
    assert.equal(authorizer.Authorize(Fixture.AppRoute(HttpMethod.Delete, undefined, 'finance'), Fixture.Session({ app_roles: ['finance'] })), AuthorizationOutcome.Allowed)
})

test('AnySignedIn opens a route only as a tenant role requirement, never as an application role', () =>
{
    const authorizer = new ClaimsAuthorizer()
    const route = Fixture.AppRoute(HttpMethod.Post, undefined, ClaimsAuthorizer.AnySignedIn)
    assert.equal(authorizer.Authorize(route, Fixture.Session({ app_roles: ['x'] })), AuthorizationOutcome.Forbidden)
})

test('the claims a realm issues, read back by the relying party, satisfy the matching route requirements', () =>
{
    const issued = RealmRoleClaims.FromPayload({ roles: ['admin'], app_roles: { ledger: ['finance'], crm: ['sales'] } })
    const session = Fixture.Session({ roles: issued.TenantRoles, app_roles: issued.RolesOf('ledger') })
    const authorizer = new ClaimsAuthorizer()
    assert.equal(authorizer.Authorize(Fixture.AppRoute(HttpMethod.Post, undefined, 'finance'), session), AuthorizationOutcome.Allowed)
    assert.equal(authorizer.Authorize(Fixture.AppRoute(HttpMethod.Post, undefined, 'sales'), session), AuthorizationOutcome.Forbidden)
    assert.equal(authorizer.Authorize(Fixture.AppRoute(HttpMethod.Post, 'admin', undefined), session), AuthorizationOutcome.Allowed)
})
