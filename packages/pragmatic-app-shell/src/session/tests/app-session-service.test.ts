import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionService } from '../app-session-service.js'
import { ApiClientBase } from '../../api/api-client-base.js'
import { SessionKit } from './session-kit.js'
import { Deferred, RoutedFetch, Tick } from '../../tests/support.js'

// An application client: its own route, the same session signals.
class ThingsRoute
{
    public static Read(client: ApiClientBase): Promise<unknown>
    {
        return (client as unknown as { Get(route: string): Promise<unknown> }).Get('/api/things')
    }
}

describe('AppSessionService', () =>
{
    it('before Initialize it is signed out and its client is not usable', () =>
    {
        const service = new AppSessionService(new ServiceProvider())
        assert.equal(service.IsSignedIn, false)
        assert.equal(service.Email, '')
        assert.deepEqual(service.Roles, [])
        assert.deepEqual(service.AppRoles, [])
        assert.equal(service.HasAnyAppRole(['x']), false)
        assert.equal(service.ChangePasswordCommand.CanExecute(), false)
        assert.throws(() => service.Client, /before Initialize/)
    })

    it('Initialize exposes the session and raises what changed', () =>
    {
        const kit = new SessionKit()
        const service = new AppSessionService(kit.Provider)
        const raised: string[] = []
        service.PropertyChanged('Email').subscribe(e => { raised.push(String(e.newValue)) })
        service.Initialize(kit.Client, kit.Service.Session!, kit.Page)
        assert.deepEqual(raised, [SessionKit.Email])
        assert.equal(service.IsSignedIn, true)
        assert.equal(service.Subject, 'subject-1')
        assert.equal(service.ProductName, 'Console')
        assert.equal(service.HasRole('viewer'), true)
        assert.equal(service.HasRole('admin'), false)
    })

    it('any request of the client answered 401 expires the session: one reload, back to sign-in', async () =>
    {
        const kit = new SessionKit()
        kit.Fetch.On('GET', '/api/things', () => RoutedFetch.Json(401, { error: 'Not signed in' }))
        await assert.rejects(ThingsRoute.Read(kit.Client))
        await assert.rejects(ThingsRoute.Read(kit.Client))
        assert.equal(kit.Page.Reloads, 1)
    })

    it('a 403 keeps the session and says access was refused', async () =>
    {
        const kit = new SessionKit()
        kit.Fetch.On('GET', '/api/things', () => RoutedFetch.Json(403, { error: 'Forbidden' }))
        await assert.rejects(ThingsRoute.Read(kit.Client))
        assert.equal(kit.Page.Reloads, 0)
        assert.equal(kit.Service.AccessNotice, 'This sign-in is not allowed to do that.')
    })

    it('a re-Initialize listens to the new client only', async () =>
    {
        const kit = new SessionKit()
        const old = kit.Client
        const next = new SessionKit()
        kit.Service.Initialize(next.Client, next.Service.Session!, kit.Page)
        kit.Fetch.On('GET', '/api/things', () => RoutedFetch.Json(401, {}))
        await assert.rejects(ThingsRoute.Read(old))
        assert.equal(kit.Page.Reloads, 0)
    })

    it('Logout signs out, then reloads once; a second logout in flight is refused', async () =>
    {
        const kit = new SessionKit()
        const held = new Deferred<void>()
        kit.Fetch.On('POST', '/api/logout', async () => { await held.Promise; return RoutedFetch.Empty(204) })
        const first = kit.Service.Logout()
        assert.equal(kit.Service.LogoutCommand.CanExecute(), false)
        await kit.Service.Logout()
        held.Resolve()
        await first
        assert.equal(kit.Fetch.Count('POST', '/api/logout'), 1)
        assert.equal(kit.Page.Reloads, 1)
    })

    it('a failed logout stays on the page, reports the error and re-enables the command', async () =>
    {
        const kit = new SessionKit()
        kit.Fetch.On('POST', '/api/logout', () => RoutedFetch.Json(503, { error: 'Unavailable' }))
        await kit.Service.Logout()
        assert.equal(kit.Service.LogoutError, 'Unavailable')
        assert.equal(kit.Page.Reloads, 0)
        assert.equal(kit.Service.LogoutCommand.CanExecute(), true)
    })

    it('Expire reloads at most once', () =>
    {
        const kit = new SessionKit()
        kit.Service.Expire()
        kit.Service.Expire()
        assert.equal(kit.Page.Reloads, 1)
    })

    it('offers Change password only when the application has the route and the session carries an email', () =>
    {
        assert.equal(new SessionKit().Service.ChangePasswordCommand.CanExecute(), true)
        assert.equal(new SessionKit({ Paths: {} }).Service.ChangePasswordCommand.CanExecute(), false)
        assert.equal(new SessionKit({}, { roles: ['viewer'] }).Service.ChangePasswordCommand.CanExecute(), false)
    })

    it('Change password without a dialog service says so', async () =>
    {
        const kit = new SessionKit()
        await kit.Service.ChangePassword()
        assert.equal(kit.Service.AccountNotice, 'Dialogs are not available.')
    })

    it('WithExpirySuspended defers a 401 and checks the session once afterwards', async () =>
    {
        const kit = new SessionKit().SessionAlive(true)
        await kit.Service.WithExpirySuspended(async () => { kit.Service.Expire() })
        await Tick.Settle()
        assert.equal(kit.Fetch.Count('GET', '/api/session'), 1)
        assert.equal(kit.Page.Reloads, 0)
        const gone = new SessionKit().SessionAlive(false)
        await gone.Service.WithExpirySuspended(async () => { gone.Service.Expire() })
        await Tick.Settle()
        assert.equal(gone.Page.Reloads, 1)
    })

    it('a failed re-check keeps the page (the next request decides)', async () =>
    {
        const kit = new SessionKit()
        kit.Fetch.On('GET', '/api/session', () => RoutedFetch.Json(503, { error: 'down' }))
        await kit.Service.WithExpirySuspended(async () => { kit.Service.Expire() })
        await Tick.Settle()
        assert.equal(kit.Page.Reloads, 0)
    })
})
