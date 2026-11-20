import { Key, RelayCommand, type KeyEventArgs } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { IPageNavigator, IPageReloader } from '../browser/browser-page.js'
import type { AppShellConfig } from '../config/app-shell-config.js'
import { SignInMethod } from '../config/sign-in-method.js'

/** The two ways the page signs someone in (AppSessionClient is one). */
export interface ISignInClient
{
    PasswordLogin(email: string, password: string): Promise<void>
    BeginOidcSignIn(navigator: IPageNavigator): void
}

/** The page the sign-in view model drives: reload after a password sign-in, navigate for OIDC. */
export interface ISignInPage extends IPageReloader, IPageNavigator
{
}

/**
 * The sign-in page. Offers what the application configured: Sign in (the OIDC redirect; the identity provider owns
 * the credentials) and, for the platform admin console's break-glass, an email + password form. A successful password
 * sign-in reloads the page, which boots into the shell with the new session cookie; a failed one shows why and clears
 * the password so it is not kept around. Busy stays set once the page is leaving (redirect or reload), so nothing
 * submits twice. Enter in either box submits the form: the form's KeyDown trigger runs SubmitKeyCommand with the key
 * args. ShowError says why the shell could not start (the session probe failed); Try again reloads.
 */
export class SignInPageViewModel extends Observable
{
    private static readonly EmailProperty = 'Email'
    private static readonly PasswordProperty = 'Password'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly IsBusyProperty = 'IsBusy'
    private static readonly SignInText = 'Sign in'
    private static readonly PasswordSignInText = 'Sign in with password'
    private static readonly RetryText = 'Try again'
    private static readonly NoText = ''

    private email = SignInPageViewModel.NoText
    private password = SignInPageViewModel.NoText
    private errorText = SignInPageViewModel.NoText
    private isBusy = false
    private readonly signInCommand: RelayCommand
    private readonly passwordSignInCommand: RelayCommand
    private readonly submitKeyCommand: RelayCommand
    private readonly retryCommand: RelayCommand

    public constructor(private readonly config: AppShellConfig, private readonly client: ISignInClient, private readonly page: ISignInPage)
    {
        super()
        this.signInCommand = new RelayCommand(() => this.SignIn(), () => !this.isBusy && this.OffersOidc, { Text: SignInPageViewModel.SignInText })
        this.passwordSignInCommand = new RelayCommand(() => { void this.PasswordSignIn() }, () => this.CanPasswordSignIn, { Text: SignInPageViewModel.PasswordSignInText })
        this.submitKeyCommand = new RelayCommand((args) => this.OnKey(args))
        this.retryCommand = new RelayCommand(() => this.Retry(), () => !this.isBusy, { Text: SignInPageViewModel.RetryText })
    }

    public get ProductName(): string
    {
        return this.config.ProductName
    }

    public get OffersOidc(): boolean
    {
        return this.config.Offers(SignInMethod.Oidc)
    }

    public get OffersPassword(): boolean
    {
        return this.config.Offers(SignInMethod.Password)
    }

    /** Both methods are offered: the page separates them. */
    public get OffersBoth(): boolean
    {
        return this.OffersOidc && this.OffersPassword
    }

    public get Email(): string
    {
        return this.email
    }

    public set Email(next: string)
    {
        const old = this.email
        if (old === next)
        {
            return
        }
        this.email = next
        this.RaisePropertyChanged(SignInPageViewModel.EmailProperty, old, next)
        this.passwordSignInCommand.RaiseCanExecuteChanged()
    }

    public get Password(): string
    {
        return this.password
    }

    public set Password(next: string)
    {
        const old = this.password
        if (old === next)
        {
            return
        }
        this.password = next
        this.RaisePropertyChanged(SignInPageViewModel.PasswordProperty, old, next)
        this.passwordSignInCommand.RaiseCanExecuteChanged()
    }

    /** Why the last sign-in failed, or why the shell could not start; '' when none. */
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get IsBusy(): boolean
    {
        return this.isBusy
    }

    /** The OIDC redirect. */
    public get SignInCommand(): RelayCommand
    {
        return this.signInCommand
    }

    /** The password form's submit. */
    public get PasswordSignInCommand(): RelayCommand
    {
        return this.passwordSignInCommand
    }

    /** Receives the form's KeyDown args: Return submits the password form (when it could), any other key is left alone. */
    public get SubmitKeyCommand(): RelayCommand
    {
        return this.submitKeyCommand
    }

    public get RetryCommand(): RelayCommand
    {
        return this.retryCommand
    }

    public ShowError(text: string): void
    {
        this.SetErrorText(text)
    }

    /** Signs in with the entered email and password; on success the page reloads into the shell. */
    public async PasswordSignIn(): Promise<void>
    {
        if (!this.CanPasswordSignIn)
        {
            return
        }
        this.SetErrorText(SignInPageViewModel.NoText)
        this.SetBusy(true)
        try
        {
            await this.client.PasswordLogin(this.email.trim(), this.password)
        }
        catch (e)
        {
            this.Password = SignInPageViewModel.NoText
            this.SetErrorText(e instanceof Error ? e.message : String(e))
            this.SetBusy(false)
            return
        }
        this.page.Reload()
    }

    private SignIn(): void
    {
        if (this.isBusy || !this.OffersOidc)
        {
            return
        }
        this.SetErrorText(SignInPageViewModel.NoText)
        this.SetBusy(true)
        this.client.BeginOidcSignIn(this.page)
    }

    private Retry(): void
    {
        if (this.isBusy)
        {
            return
        }
        this.SetBusy(true)
        this.page.Reload()
    }

    private OnKey(args: unknown): void
    {
        const key = args as Partial<KeyEventArgs> | undefined
        if (key === undefined || key.Handled === true || key.Key !== Key.Return || !this.CanPasswordSignIn)
        {
            return
        }
        key.Handled = true
        void this.PasswordSignIn()
    }

    private get CanPasswordSignIn(): boolean
    {
        return !this.isBusy && this.OffersPassword && this.email.trim() !== SignInPageViewModel.NoText && this.password !== SignInPageViewModel.NoText
    }

    private SetErrorText(next: string): void
    {
        const old = this.errorText
        if (old === next)
        {
            return
        }
        this.errorText = next
        this.RaisePropertyChanged(SignInPageViewModel.ErrorTextProperty, old, next)
    }

    private SetBusy(next: boolean): void
    {
        const old = this.isBusy
        if (old === next)
        {
            return
        }
        this.isBusy = next
        this.RaisePropertyChanged(SignInPageViewModel.IsBusyProperty, old, next)
        this.signInCommand.RaiseCanExecuteChanged()
        this.passwordSignInCommand.RaiseCanExecuteChanged()
        this.retryCommand.RaiseCanExecuteChanged()
    }
}
