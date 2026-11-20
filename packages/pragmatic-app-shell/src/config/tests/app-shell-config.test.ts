import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppShellConfig } from '../app-shell-config.js'
import { SignInMethod } from '../sign-in-method.js'

describe('AppShellConfig', () =>
{
    it('defaults to OIDC sign-in on the app-host default paths at the origin root', () =>
    {
        const config = new AppShellConfig({ ProductName: 'Personal Cabinet' })
        assert.equal(config.ProductName, 'Personal Cabinet')
        assert.deepEqual(config.SignInMethods, [SignInMethod.Oidc])
        assert.equal(config.Offers(SignInMethod.Oidc), true)
        assert.equal(config.Offers(SignInMethod.Password), false)
        assert.equal(config.ApiBasePath, '')
        assert.deepEqual({ ...config.Paths }, {
            Session: '/api/session',
            Logout: '/api/logout',
            PasswordLogin: '/api/login',
            OidcBegin: '/auth/oidc/begin',
            WsTicket: '/api/ws-ticket',
            ChangePassword: undefined,
        })
        assert.equal(config.MinPasswordLength, 12)
        assert.equal(config.EmailClaim, 'email')
        assert.equal(config.RolesClaim, 'roles')
    })

    it('redirects a signed-out visitor straight to the identity provider only when OIDC is the one method', () =>
    {
        assert.equal(new AppShellConfig({ ProductName: 'A' }).RedirectsWhenSignedOut, true)
        assert.equal(new AppShellConfig({ ProductName: 'A', SignInMethods: [SignInMethod.Oidc, SignInMethod.Password] }).RedirectsWhenSignedOut, false)
        assert.equal(new AppShellConfig({ ProductName: 'A', SignInMethods: [SignInMethod.Password] }).RedirectsWhenSignedOut, false)
        assert.equal(new AppShellConfig({ ProductName: 'A', RedirectWhenSignedOut: false }).RedirectsWhenSignedOut, false)
    })

    it('takes path overrides one by one and keeps the rest', () =>
    {
        const config = new AppShellConfig({ ProductName: 'A', Paths: { Session: '/tenant-auth/session', ChangePassword: '/api/session/password' } })
        assert.equal(config.Paths.Session, '/tenant-auth/session')
        assert.equal(config.Paths.Logout, '/api/logout')
        assert.equal(config.Paths.ChangePassword, '/api/session/password')
        assert.equal(config.ChangesPassword, true)
        assert.equal(new AppShellConfig({ ProductName: 'A' }).ChangesPassword, false)
    })

    it('refuses an empty product name, no sign-in method, and a base path that is not a same-origin path prefix', () =>
    {
        assert.throws(() => new AppShellConfig({ ProductName: ' ' }), /product name/)
        assert.throws(() => new AppShellConfig({ ProductName: 'A', SignInMethods: [] }), /sign-in method/)
        for (const bad of ['console', '/console/', '//evil.example', 'https://evil.example', '/a\\b'])
        {
            assert.throws(() => new AppShellConfig({ ProductName: 'A', ApiBasePath: bad }), /base path/, bad)
        }
        assert.equal(new AppShellConfig({ ProductName: 'A', ApiBasePath: '/console' }).ApiBasePath, '/console')
    })

    it('refuses a path override that is not an own-origin absolute path', () =>
    {
        assert.throws(() => new AppShellConfig({ ProductName: 'A', Paths: { Session: 'https://idp.example/session' } }), /path/)
        assert.throws(() => new AppShellConfig({ ProductName: 'A', Paths: { Logout: '//idp.example/logout' } }), /path/)
    })

    it('refuses a minimum password length below one', () =>
    {
        assert.throws(() => new AppShellConfig({ ProductName: 'A', MinPasswordLength: 0 }), /password length/)
    })
})
