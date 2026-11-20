import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { PasswordChanged } from '../api/app-session-client.js'
import type { AppSessionService } from '../session/app-session-service.js'
import { ShellDialogViewModel } from './shell-dialog-view-model.js'

/**
 * Change my password: the signed-in person's current password, a new one and its confirmation. It acts on their own
 * account only, so it needs no role. Confirm stays disabled until the current password is filled, the new one is long
 * enough (the application's MinPasswordLength) and differs from it, and the confirmation matches; NewPasswordText and
 * MismatchText say why while they do not. The passwords are input only: never echoed back, and cleared whenever the
 * dialog closes (changed, cancelled or dismissed). A wrong current password, or a throttled attempt, keeps the dialog
 * open with the server's reason in ErrorText. While the request is in flight the session does not treat a 401 as
 * expiry: the server ends the old session before the fresh cookie lands. Resolves with the server's reply.
 */
export class ChangePasswordDialogViewModel extends ShellDialogViewModel<PasswordChanged>
{
    private static readonly CurrentPasswordProperty = 'CurrentPassword'
    private static readonly NewPasswordProperty = 'NewPassword'
    private static readonly ConfirmPasswordProperty = 'ConfirmPassword'
    private static readonly NewPasswordTextProperty = 'NewPasswordText'
    private static readonly MismatchTextProperty = 'MismatchText'
    private static readonly TooShortPrefix = 'Use at least '
    private static readonly TooShortSuffix = ' characters.'
    private static readonly SameText = 'The new password must differ from the current one.'
    private static readonly NoMatchText = 'The two new passwords do not match.'
    private static readonly NoText = ''

    private currentPassword = ChangePasswordDialogViewModel.NoText
    private newPassword = ChangePasswordDialogViewModel.NoText
    private confirmPassword = ChangePasswordDialogViewModel.NoText
    private readonly account: AppSessionService

    public constructor(session: AppSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
        this.account = session
    }

    /** Who the change is for: always the signed-in person. */
    public get Email(): string
    {
        return this.account.Email
    }

    public get MinPasswordLength(): number
    {
        return this.account.Client.Config.MinPasswordLength
    }

    public get CurrentPassword(): string
    {
        return this.currentPassword
    }

    public set CurrentPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.CurrentPasswordProperty, this.currentPassword, value, v => { this.currentPassword = v })
    }

    public get NewPassword(): string
    {
        return this.newPassword
    }

    public set NewPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.NewPasswordProperty, this.newPassword, value, v => { this.newPassword = v })
    }

    public get ConfirmPassword(): string
    {
        return this.confirmPassword
    }

    public set ConfirmPassword(value: string)
    {
        this.SetPassword(ChangePasswordDialogViewModel.ConfirmPasswordProperty, this.confirmPassword, value, v => { this.confirmPassword = v })
    }

    /** Why the new password is not acceptable yet, once something is typed; '' when it is. */
    public get NewPasswordText(): string
    {
        if (this.newPassword.length === 0)
        {
            return ChangePasswordDialogViewModel.NoText
        }
        if (this.newPassword.length < this.MinPasswordLength)
        {
            return ChangePasswordDialogViewModel.TooShortPrefix + this.MinPasswordLength + ChangePasswordDialogViewModel.TooShortSuffix
        }
        return this.newPassword === this.currentPassword ? ChangePasswordDialogViewModel.SameText : ChangePasswordDialogViewModel.NoText
    }

    /** Why Confirm is off while the confirmation differs from the new password; '' before it is typed. */
    public get MismatchText(): string
    {
        return this.confirmPassword.length === 0 || this.confirmPassword === this.newPassword
            ? ChangePasswordDialogViewModel.NoText
            : ChangePasswordDialogViewModel.NoMatchText
    }

    /** Whatever closes the dialog, the typed passwords do not outlive it. */
    public override async Open(title: string): Promise<PasswordChanged | undefined>
    {
        try
        {
            return await super.Open(title)
        }
        finally
        {
            this.Clear()
        }
    }

    protected override get CanConfirm(): boolean
    {
        return this.currentPassword.length > 0
            && this.newPassword.length >= this.MinPasswordLength
            && this.newPassword !== this.currentPassword
            && this.confirmPassword === this.newPassword
    }

    protected override async SubmitCore(): Promise<PasswordChanged>
    {
        const current = this.currentPassword
        const next = this.newPassword
        const confirm = this.confirmPassword
        const reply = await this.account.WithExpirySuspended(() => this.account.Client.ChangeOwnPassword(current, next, confirm))
        this.Clear()
        return reply
    }

    private Clear(): void
    {
        this.CurrentPassword = ChangePasswordDialogViewModel.NoText
        this.NewPassword = ChangePasswordDialogViewModel.NoText
        this.ConfirmPassword = ChangePasswordDialogViewModel.NoText
    }

    // Sets one password field and re-raises the validation texts it changed.
    private SetPassword(name: string, old: string, next: string, assign: (value: string) => void): void
    {
        const oldNewText = this.NewPasswordText
        const oldMismatch = this.MismatchText
        this.SetField(name, old, next, assign)
        this.RaiseIfChanged(ChangePasswordDialogViewModel.NewPasswordTextProperty, oldNewText, this.NewPasswordText)
        this.RaiseIfChanged(ChangePasswordDialogViewModel.MismatchTextProperty, oldMismatch, this.MismatchText)
    }

    private RaiseIfChanged(name: string, old: string, next: string): void
    {
        if (old !== next)
        {
            this.RaisePropertyChanged(name, old, next)
        }
    }
}
