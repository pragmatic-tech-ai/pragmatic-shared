import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SameSiteMode, SessionCookie } from '../session-cookie.js'

class Fixture
{
    public static readonly Token = 'abc_DEF-123'
    public static readonly Now = 1_000_000

    public static Clock(): number
    {
        return Fixture.Now
    }
}

describe('SessionCookie', () =>
{
    it('builds HttpOnly, SameSite=Strict, Path=/ and Max-Age from the expiry; no Secure unless asked', () =>
    {
        const cookie = new SessionCookie({ Name: 'cp_session', Secure: false, Now: Fixture.Clock })
        const header = cookie.Build(Fixture.Token, new Date(Fixture.Now + 3_600_000))
        assert.equal(header, 'cp_session=abc_DEF-123; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600')
    })

    it('adds Secure when configured; the name, SameSite and Path are configurable', () =>
    {
        const cookie = new SessionCookie({ Name: 'pts_session', Secure: true, SameSite: SameSiteMode.Lax, Path: '/app', Now: Fixture.Clock })
        assert.equal(cookie.Build('t', new Date(Fixture.Now + 1000)), 'pts_session=t; HttpOnly; SameSite=Lax; Path=/app; Max-Age=1; Secure')
    })

    it('defaults to a Secure app_session cookie', () =>
    {
        assert.ok(new SessionCookie().Build('t', new Date(Date.now() + 60_000)).startsWith('app_session=t;'))
        assert.ok(new SessionCookie().Build('t', new Date(Date.now() + 60_000)).endsWith('; Secure'))
    })

    it('builds a clearing cookie with Max-Age=0', () =>
    {
        const header = new SessionCookie({ Name: 'cp_session', Secure: false }).BuildClearing()
        assert.match(header, /^cp_session=;/)
        assert.ok(header.includes('Max-Age=0'))
    })

    it('clamps a past expiry to zero', () =>
    {
        const cookie = new SessionCookie({ Secure: false, Now: Fixture.Clock })
        assert.ok(cookie.Build('t', new Date(Fixture.Now - 10_000)).includes('Max-Age=0'))
    })

    it('reads the token amid other cookies and from a single pair; absent is null', () =>
    {
        const cookie = new SessionCookie({ Name: 'cp_session', Secure: false })
        assert.equal(cookie.Read('a=1; cp_session=abc; b=2'), 'abc')
        assert.equal(cookie.Read('cp_session=onlyone'), 'onlyone')
        assert.equal(cookie.Read('x=1'), null)
        assert.equal(cookie.Read(undefined), null)
    })

    it('ignores a lookalike name', () =>
    {
        assert.equal(new SessionCookie({ Name: 'cp_session' }).Read('xcp_session=bad; cp_session=good'), 'good')
    })

    it('a duplicated cookie, an empty value or a token outside base64url is null', () =>
    {
        const cookie = new SessionCookie({ Name: 'cp_session' })
        assert.equal(cookie.Read('cp_session=a; cp_session=b'), null)
        assert.equal(cookie.Read('cp_session='), null)
        assert.equal(cookie.Read('cp_session=bad token!'), null)
        assert.equal(cookie.Read('cp_session=a.b'), null)
    })

    it('Build refuses a token the reader would not accept', () =>
    {
        assert.throws(() => new SessionCookie().Build('a;b', new Date()))
    })

    it('an OIDC sign-in surface makes the default SameSite Lax; Strict stays without one; an explicit mode always stays', () =>
    {
        const passwordOnly = new SessionCookie({ Secure: false })
        assert.equal(passwordOnly.SameSite, SameSiteMode.Strict)
        const oidc = new SessionCookie({ Secure: false, Now: Fixture.Clock })
        oidc.AdmitCrossSiteSignIn()
        assert.equal(oidc.SameSite, SameSiteMode.Lax)
        assert.ok(oidc.Build('t', new Date(Fixture.Now + 1000)).includes('; SameSite=Lax;'))
        assert.ok(oidc.BuildClearing().includes('; SameSite=Lax;'))
        const pinned = new SessionCookie({ Secure: false, SameSite: SameSiteMode.Strict })
        pinned.AdmitCrossSiteSignIn()
        assert.equal(pinned.SameSite, SameSiteMode.Strict)
    })
})
