import type { AppSession } from '../api/app-session.js'
import type { AppSessionClient } from '../api/app-session-client.js'
import type { IPageNavigator } from '../browser/browser-page.js'

/** What the boot did. */
export enum BootOutcome
{
    /** A session: the shell is mounted. */
    Shell = 'shell',
    /** No session, and the application signs in by OIDC only: the browser left for the identity provider. */
    Redirected = 'redirected',
    /** No session: the sign-in page is mounted. */
    SignInPage = 'sign-in-page',
    /** The session probe failed (host down, network): the sign-in page says so. */
    Unreachable = 'unreachable',
}

/**
 * The application's two compiled applications and how to wire them. TApp is the Mural Application in a browser
 * (BrowserShellMount mounts one); anything in tests. Each is loaded only when needed (a dynamic import of the
 * compiled .mu), so the sign-in page never loads the shell.
 */
export interface IShellApplications<TApp>
{
    LoadSignIn(): Promise<TApp>
    LoadShell(): Promise<TApp>
    /** Shows why the shell could not start on the sign-in page (its SignInPageViewModel.ShowError). */
    ShowSignInError(app: TApp, message: string): void
    /** Binds the session service (AppSessionService.Initialize) and anything else the shell needs before it mounts. */
    StartShell(app: TApp, session: AppSession, client: AppSessionClient): Promise<void> | void
    Mount(app: TApp): void
}

/**
 * Boots an application in a plain browser tab. Probes the session cookie, then loads exactly one application: the
 * shell when there is a session, else either the identity provider (an OIDC-only application) or the sign-in page.
 * A probe that fails for another reason shows the sign-in page saying the application cannot be reached. Signing in,
 * signing out and expiry all reload the page, so each boot starts from a clean slate.
 */
export class AppShellBoot<TApp>
{
    private static readonly UnreachablePrefix = "Can't reach "
    private static readonly UnreachableSeparator = ': '

    public constructor(private readonly client: AppSessionClient, private readonly apps: IShellApplications<TApp>, private readonly navigator: IPageNavigator)
    {
    }

    public async Run(): Promise<BootOutcome>
    {
        let session: AppSession | null
        try
        {
            session = await this.client.Session()
        }
        catch (e)
        {
            const app = await this.apps.LoadSignIn()
            this.apps.ShowSignInError(app, this.UnreachableText(e))
            this.apps.Mount(app)
            return BootOutcome.Unreachable
        }
        if (session === null)
        {
            if (this.client.Config.RedirectsWhenSignedOut)
            {
                this.client.BeginOidcSignIn(this.navigator)
                return BootOutcome.Redirected
            }
            this.apps.Mount(await this.apps.LoadSignIn())
            return BootOutcome.SignInPage
        }
        const shell = await this.apps.LoadShell()
        const started = this.apps.StartShell(shell, session, this.client)
        this.apps.Mount(shell)
        await started
        return BootOutcome.Shell
    }

    private UnreachableText(failure: unknown): string
    {
        const message = failure instanceof Error ? failure.message : String(failure)
        return AppShellBoot.UnreachablePrefix + this.client.Config.ProductName + AppShellBoot.UnreachableSeparator + message
    }
}
