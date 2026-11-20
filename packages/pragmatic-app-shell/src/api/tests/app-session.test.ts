import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppSession } from '../app-session.js'
import { AppShellConfig } from '../../config/app-shell-config.js'

describe('AppSession', () =>
{
    const config = new AppShellConfig({ ProductName: 'A' })

    it('reads claims as multi-valued, first value for single reads', () =>
    {
        const session = AppSession.FromWire({ subject: 's', claims: { email: ['a@x.test', 'b@x.test'], tenant: ['t1'] } }, config)
        assert.equal(session.Claim('email'), 'a@x.test')
        assert.deepEqual(session.Values('email'), ['a@x.test', 'b@x.test'])
        assert.equal(session.Claim('missing'), undefined)
        assert.deepEqual(session.Values('missing'), [])
        assert.equal(session.Email, 'a@x.test')
    })

    it('checks roles from the configured roles claim', () =>
    {
        const custom = new AppShellConfig({ ProductName: 'A', RolesClaim: 'app_roles', EmailClaim: 'mail' })
        const session = AppSession.FromWire({ subject: 's', claims: { app_roles: ['operator'], roles: ['owner'], mail: ['m@x.test'] } }, custom)
        assert.deepEqual(session.Roles, ['operator'])
        assert.equal(session.HasRole('operator'), true)
        assert.equal(session.HasRole('owner'), false)
        assert.equal(session.HasAnyRole(['owner', 'operator']), true)
        assert.equal(session.HasAnyRole([]), false)
        assert.equal(session.Email, 'm@x.test')
    })

    it('reads tenant roles from roles and the application roles from app_roles by default', () =>
    {
        const session = AppSession.FromWire({ subject: 's', claims: { roles: ['admin'], app_roles: ['finance'] } }, config)
        assert.deepEqual(session.Roles, ['admin'])
        assert.deepEqual(session.AppRoles, ['finance'])
        assert.equal(session.HasAppRole('finance'), true)
        assert.equal(session.HasAppRole('admin'), false)
        assert.equal(session.HasAnyAppRole(['sales', 'finance']), true)
        assert.equal(session.HasAnyAppRole([]), false)
        assert.equal(config.AppRolesClaim, AppShellConfig.DefaultAppRolesClaim)
    })

    it('has no email when the claim is absent, and tolerates a reply without claims', () =>
    {
        const session = AppSession.FromWire({ subject: 's' } as never, config)
        assert.equal(session.Email, '')
        assert.deepEqual(session.Roles, [])
    })

    it('refuses a reply without a subject, and ignores claim values that are not strings', () =>
    {
        assert.throws(() => AppSession.FromWire({ claims: {} } as never, config), /subject/)
        const session = AppSession.FromWire({ subject: 's', claims: { roles: ['a', 3, null], email: 'x' } } as never, config)
        assert.deepEqual(session.Roles, ['a'])
        assert.equal(session.Email, '')
    })
})
