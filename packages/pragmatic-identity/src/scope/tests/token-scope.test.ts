import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrincipalKind, RealmKind } from '../../core/identity-enums.js'
import { Principal } from '../../core/principal.js'
import { Realm } from '../../core/realm.js'
import { AccessContext } from '../../authz/access-context.js'
import { ResourceAuthorizationPolicy } from '../../authz/resource-authorization-policy.js'
import { DevelopMethods, RunTestMethods, ScopedAccessContext, ScopedMethods, TokenScope, TokenScopeGate } from '../token-scope.js'

class ScopeFixture
{
    public static readonly Custom = 'custom'
    public static readonly RealmId = 't1'
    public static readonly UserId = 'p1'

    public static Context(): AccessContext
    {
        const principal = new Principal(ScopeFixture.UserId, ScopeFixture.RealmId, PrincipalKind.User, new Map(), [TokenScope.ApplicationDeploy])
        return new AccessContext(principal, new Realm(ScopeFixture.RealmId, RealmKind.SelfHosted, ScopeFixture.RealmId), [], new ResourceAuthorizationPolicy())
    }
}

describe('TokenScopeGate', () =>
{
    it('the deploy scope allows only application/deploy; contribute allows graph/contribute and graph/list', () =>
    {
        const deploy = TokenScopeGate.For([TokenScope.ApplicationDeploy])
        assert.equal(deploy.Allows(ScopedMethods.ApplicationDeploy), true)
        assert.equal(deploy.Allows(ScopedMethods.GraphList), false)
        const contribute = TokenScopeGate.For([TokenScope.GraphContribute])
        assert.deepEqual([contribute.Allows(ScopedMethods.GraphContribute), contribute.Allows(ScopedMethods.GraphList), contribute.Allows(ScopedMethods.ApplicationDeploy)], [true, true, false])
    })

    it('develop and run/test allow exactly their lists, and known scopes combine as a union', () =>
    {
        const develop = TokenScopeGate.For([TokenScope.Develop])
        assert.ok(DevelopMethods.All.every(method => develop.Allows(method)))
        assert.equal(develop.Allows(ScopedMethods.ApplicationDeploy), false)
        const both = TokenScopeGate.For([TokenScope.RunTest, TokenScope.ApplicationDeploy])
        assert.ok(RunTestMethods.All.every(method => both.Allows(method)))
        assert.equal(both.Allows(ScopedMethods.ApplicationDeploy), true)
        assert.equal(both.Allows(ScopedMethods.StorageWriteText), false)
    })

    it('no known scope allows everything; a session context is unscoped, a scoped context carries its scopes', () =>
    {
        assert.equal(TokenScopeGate.For([ScopeFixture.Custom]).Allows(ScopedMethods.StorageDelete), true)
        const session = ScopeFixture.Context()
        assert.equal(TokenScopeGate.ForContext(session).Allows(ScopedMethods.StorageDelete), true)
        const scoped = new ScopedAccessContext(session, [TokenScope.Inspect])
        assert.deepEqual(scoped.Scopes, [TokenScope.Inspect])
        assert.equal(scoped.Principal, session.Principal)
        assert.equal(TokenScopeGate.ForContext(scoped).Allows(ScopedMethods.GraphLoaded), true)
        assert.equal(TokenScopeGate.ForContext(scoped).Allows(ScopedMethods.StorageDelete), false)
    })
})
