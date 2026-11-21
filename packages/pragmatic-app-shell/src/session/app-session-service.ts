import { RelayCommand, ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { ApiError } from '../api/api-error.js'
import type { AppSession } from '../api/app-session.js'
import type { AppSessionClient } from '../api/app-session-client.js'
import type { IPageNavigator, IPageReloader } from '../browser/browser-page.js'
import { ChangePasswordDialogViewModel } from '../dialogs/change-password-dialog-view-model.js'

/**
 * The signed-in session for the shell: the application's client, who is signed in (subject, email, roles from the
 * session's claims) and the account actions in the header. Registered at the application root; the boot initializes
 * it before any section resolves it. Every 401 the client receives expires the session (one reload, which lands on
 * sign-in); every 403 says so in AccessNotice. Logout reloads too, unless the host answers where the browser goes
 * next (an OIDC host: the IdP's end-session endpoint, so its SSO session ends too): the page is assigned there instead.
 * Change password opens the own-password dialog when
 * the application offers one and the session carries an email; once it lands, AccountNotice says what it did.
 * Applications derive from it for their own header facts (role labels, the tenant plate).
 */
export class AppSessionService extends ServiceBase
{
    public static readonly Key = new ServiceKey<AppSessionService>('AppSessionService')

    private static readonly EmailProperty = 'Email'
    private static readonly SubjectProperty = 'Subject'
    private static readonly IsSignedInProperty = 'IsSignedIn'
    private static readonly ProductNameProperty = 'ProductName'
    private static readonly ShowsChangePasswordProperty = 'ShowsChangePassword'
    private static readonly LogoutErrorProperty = 'LogoutError'
    private static readonly AccountNoticeProperty = 'AccountNotice'
    private static readonly AccessNoticeProperty = 'AccessNotice'
    private static readonly NotInitialized = 'AppSessionService used before Initialize.'
    private static readonly LogoutText = 'Log out'
    private static readonly ChangePasswordText = 'Change password'
    private static readonly ChangePasswordTitle = 'Change your password'
    private static readonly PasswordChangedNotice = 'Password changed. Your other sessions were signed out.'
    private static readonly NoDialogsMessage = 'Dialogs are not available.'
    private static readonly AccessRefusedNotice = 'This sign-in is not allowed to do that.'
    private static readonly NoText = ''

    private client: AppSessionClient | undefined
    private session: AppSession | undefined
    private reloader: IPageReloader | undefined
    private navigator: IPageNavigator | undefined
    private subscriptions: IDisposable[] = []
    private expired = false
    private logoutError = AppSessionService.NoText
    private loggingOut = false
    private accountNotice = AppSessionService.NoText
    private accessNotice = AppSessionService.NoText
    private changingPassword = false
    private expirySuspensions = 0
    private expiryDeferred = false
    private readonly logoutCommand: RelayCommand
    private readonly changePasswordCommand: RelayCommand

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.logoutCommand = new RelayCommand(() => { void this.Logout() }, () => !this.loggingOut, { Text: AppSessionService.LogoutText })
        this.changePasswordCommand = new RelayCommand(() => { void this.ChangePassword() },
            () => !this.changingPassword && this.CanChangePassword, { Text: AppSessionService.ChangePasswordText })
    }

    /** Binds the session and listens to the client's 401 / 403 (a previous client's are released). `navigator` takes
     *  the browser where a logout says; default the reloader when it can navigate too (BrowserPage), else none (a
     *  logout then reloads). */
    public Initialize(client: AppSessionClient, session: AppSession, reloader: IPageReloader, navigator?: IPageNavigator): void
    {
        const before = [this.Email, this.Subject, this.IsSignedIn, this.ProductName, this.ShowsChangePassword] as const
        for (const subscription of this.subscriptions)
        {
            subscription.dispose()
        }
        this.client = client
        this.session = session
        this.reloader = reloader
        this.navigator = navigator ?? AppSessionService.NavigatorOf(reloader)
        this.expired = false
        this.subscriptions = [
            client.Unauthorized.subscribe(() => this.Expire()),
            client.Forbidden.subscribe(() => this.SetAccessNotice(AppSessionService.AccessRefusedNotice)),
        ]
        const P = AppSessionService
        this.RaiseIfChanged(P.EmailProperty, before[0], this.Email)
        this.RaiseIfChanged(P.SubjectProperty, before[1], this.Subject)
        this.RaiseIfChanged(P.IsSignedInProperty, before[2], this.IsSignedIn)
        this.RaiseIfChanged(P.ProductNameProperty, before[3], this.ProductName)
        this.RaiseIfChanged(P.ShowsChangePasswordProperty, before[4], this.ShowsChangePassword)
        this.OnInitialized()
        this.changePasswordCommand.RaiseCanExecuteChanged()
    }

    public get Client(): AppSessionClient
    {
        if (this.client === undefined)
        {
            throw new Error(AppSessionService.NotInitialized)
        }
        return this.client
    }

    /** The session as the host reported it; undefined before Initialize. */
    public get Session(): AppSession | undefined
    {
        return this.session
    }

    public get IsSignedIn(): boolean
    {
        return this.session !== undefined
    }

    public get Subject(): string
    {
        return this.session?.Subject ?? AppSessionService.NoText
    }

    public get Email(): string
    {
        return this.session?.Email ?? AppSessionService.NoText
    }

    public get Roles(): readonly string[]
    {
        return this.session?.Roles ?? []
    }

    public get ProductName(): string
    {
        return this.client?.Config.ProductName ?? AppSessionService.NoText
    }

    public HasRole(role: string): boolean
    {
        return this.session?.HasRole(role) ?? false
    }

    public HasAnyRole(roles: readonly string[]): boolean
    {
        return this.session?.HasAnyRole(roles) ?? false
    }

    public get AppRoles(): readonly string[]
    {
        return this.session?.AppRoles ?? []
    }

    public HasAppRole(role: string): boolean
    {
        return this.session?.HasAppRole(role) ?? false
    }

    public HasAnyAppRole(roles: readonly string[]): boolean
    {
        return this.session?.HasAnyAppRole(roles) ?? false
    }

    /** Why the last logout failed; '' when none. A failed logout keeps the page. */
    public get LogoutError(): string
    {
        return this.logoutError
    }

    public get LogoutCommand(): RelayCommand
    {
        return this.logoutCommand
    }

    /** Opens the change-password dialog; it acts on the person's own account, so any role may. */
    public get ChangePasswordCommand(): RelayCommand
    {
        return this.changePasswordCommand
    }

    /** Whether the header shows Change password: always (greyed when not offered), unless the application hides the
     *  actions it does not offer (AppShellOptions.HideUnofferedActions) and offers no own-password change. */
    public get ShowsChangePassword(): boolean
    {
        const client = this.client
        return client === undefined || !client.Config.HidesUnofferedActions || client.ChangesPassword
    }

    /** What the last account action did ('Password changed...'); '' when none. */
    public get AccountNotice(): string
    {
        return this.accountNotice
    }

    /** Set when the host refused a request (403); '' until then. */
    public get AccessNotice(): string
    {
        return this.accessNotice
    }

    /** Asks for the current and a new password and changes it. One dialog at a time; resolves once it closes. */
    public async ChangePassword(): Promise<void>
    {
        if (this.changingPassword || !this.CanChangePassword)
        {
            return
        }
        const dialogs = this.Provider.get(DialogService.Key)
        if (dialogs === undefined)
        {
            this.SetAccountNotice(AppSessionService.NoDialogsMessage)
            return
        }
        this.SetChangingPassword(true)
        this.SetAccountNotice(AppSessionService.NoText)
        try
        {
            const changed = await new ChangePasswordDialogViewModel(this, dialogs).Open(AppSessionService.ChangePasswordTitle)
            if (changed !== undefined)
            {
                this.SetAccountNotice(changed.warning ?? AppSessionService.PasswordChangedNotice)
            }
        }
        catch (e)
        {
            this.SetAccountNotice(e instanceof Error ? e.message : String(e))
        }
        finally
        {
            this.SetChangingPassword(false)
        }
    }

    /**
     * Runs `work` (a password change) with expiry suspended: the server ends the old session before the fresh cookie
     * lands, so a request answered 401 meanwhile is not the session ending. Such a 401 is remembered, and once the
     * work is done the session is checked once: expired only if it is gone.
     */
    public async WithExpirySuspended<T>(work: () => Promise<T>): Promise<T>
    {
        this.expirySuspensions++
        try
        {
            return await work()
        }
        finally
        {
            this.expirySuspensions--
            if (this.expirySuspensions === 0 && this.expiryDeferred)
            {
                this.expiryDeferred = false
                await this.RecheckSession()
            }
        }
    }

    /** Ends the session for this page: reloads at most once, landing on sign-in. While suspended it is only remembered. */
    public Expire(): void
    {
        if (this.expired)
        {
            return
        }
        if (this.expirySuspensions > 0)
        {
            this.expiryDeferred = true
            return
        }
        this.expired = true
        this.reloader?.Reload()
    }

    /**
     * Signs out, then reloads to sign-in, or leaves for where the host said (the IdP's end-session endpoint). A 401
     * means the session is already gone, so it reloads too; any other failure leaves the person signed in, so it reports
     * the error and stays. A second call in flight, or once the page is leaving, is a no-op.
     */
    public async Logout(): Promise<void>
    {
        if (this.loggingOut || this.expired)
        {
            return
        }
        this.SetLoggingOut(true)
        this.SetLogoutError(AppSessionService.NoText)
        let destination: string | undefined
        try
        {
            destination = await this.Client.Logout()
        }
        catch (e)
        {
            if (ApiError.Is(e, ApiError.UnauthorizedStatus))
            {
                this.Expire()
                return
            }
            this.SetLogoutError(e instanceof Error ? e.message : String(e))
            return
        }
        finally
        {
            this.SetLoggingOut(false)
        }
        if (this.expired)
        {
            // A 401 elsewhere already reloads the page; navigating now would race it.
            return
        }
        if (destination !== undefined && this.navigator !== undefined)
        {
            this.expired = true
            this.navigator.Assign(destination)
            return
        }
        this.Expire()
    }

    /** A derived service's hook to raise its own facts after Initialize. */
    protected OnInitialized(): void
    {
    }

    /** Raises `name` when the value changed (derived services' Initialize uses it too). */
    protected RaiseIfChanged<T>(name: string, old: T, next: T): void
    {
        if (old !== next)
        {
            this.RaisePropertyChanged(name, old, next)
        }
    }

    // The reloader when it is a navigator too (the browser page is both).
    private static NavigatorOf(reloader: IPageReloader): IPageNavigator | undefined
    {
        const candidate = reloader as IPageReloader & Partial<IPageNavigator>
        return typeof candidate.Assign === 'function' ? candidate as IPageNavigator : undefined
    }

    private get CanChangePassword(): boolean
    {
        return this.client !== undefined && this.client.ChangesPassword && this.Email.length > 0
    }

    // The deferred check: expires when the server says there is no session; a failed check keeps the page.
    private async RecheckSession(): Promise<void>
    {
        let alive: boolean
        try
        {
            alive = (await this.Client.Session()) !== null
        }
        catch
        {
            alive = true
        }
        if (!alive)
        {
            this.Expire()
        }
    }

    private SetChangingPassword(next: boolean): void
    {
        this.changingPassword = next
        this.changePasswordCommand.RaiseCanExecuteChanged()
    }

    private SetAccountNotice(next: string): void
    {
        const old = this.accountNotice
        this.accountNotice = next
        this.RaiseIfChanged(AppSessionService.AccountNoticeProperty, old, next)
    }

    private SetAccessNotice(next: string): void
    {
        const old = this.accessNotice
        this.accessNotice = next
        this.RaiseIfChanged(AppSessionService.AccessNoticeProperty, old, next)
    }

    private SetLoggingOut(next: boolean): void
    {
        this.loggingOut = next
        this.logoutCommand.RaiseCanExecuteChanged()
    }

    private SetLogoutError(next: string): void
    {
        const old = this.logoutError
        this.logoutError = next
        this.RaiseIfChanged(AppSessionService.LogoutErrorProperty, old, next)
    }
}
