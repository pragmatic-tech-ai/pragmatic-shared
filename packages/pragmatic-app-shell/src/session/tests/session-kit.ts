import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { AppSessionClient } from '../../api/app-session-client.js'
import { AppSession } from '../../api/app-session.js'
import { AppShellConfig, type AppShellOptions } from '../../config/app-shell-config.js'
import { AppSessionService } from '../app-session-service.js'
import { FakeDialogService, FakePage, RoutedFetch } from '../../tests/support.js'

/** A signed-in session service over a real AppSessionClient whose fetch is routed by hand. */
export class SessionKit
{
    public static readonly Email = 'person@example.test'
    public static readonly PasswordPath = '/api/session/password'

    public readonly Fetch = new RoutedFetch()
    public readonly Page = new FakePage()
    public readonly Provider = new ServiceProvider()
    public readonly Config: AppShellConfig
    public readonly Client: AppSessionClient
    public readonly Service: AppSessionService

    public constructor(options: Partial<AppShellOptions> = {}, claims: Record<string, string[]> = { email: [SessionKit.Email], roles: ['viewer'] })
    {
        this.Config = new AppShellConfig({ ProductName: 'Console', Paths: { ChangePassword: SessionKit.PasswordPath }, ...options })
        this.Client = new AppSessionClient(this.Config, this.Fetch.Fetch)
        this.Service = new AppSessionService(this.Provider)
        this.Service.Initialize(this.Client, AppSession.FromWire({ subject: 'subject-1', claims }, this.Config), this.Page)
        this.Provider.registerInstance(AppSessionService.Key, this.Service)
    }

    public UseDialogs(): FakeDialogService
    {
        const dialogs = new FakeDialogService(this.Provider)
        this.Provider.registerInstance(DialogService.Key, dialogs)
        return dialogs
    }

    /** The session probe answers alive (200) or gone (401). */
    public SessionAlive(alive: boolean): SessionKit
    {
        this.Fetch.On('GET', '/api/session', () => alive
            ? RoutedFetch.Json(200, { subject: 'subject-1', claims: {} })
            : RoutedFetch.Json(401, { error: 'Not signed in' }))
        return this
    }
}
