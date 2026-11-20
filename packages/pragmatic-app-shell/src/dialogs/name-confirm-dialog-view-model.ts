import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ShellDialogViewModel, type IShellSessionExpiry } from './shell-dialog-view-model.js'

/** What a name-confirm dialog confirms. */
export interface NameConfirmRequest
{
    /** The name the operator must type. */
    readonly Expected: string
    /** What the action does, shown above the field. */
    readonly Message: string
    /** Runs inside the dialog once confirmed; a refusal it throws shows in ErrorText. Gets the trimmed reason ('' when
     *  none is asked). */
    readonly Action: (reason: string) => Promise<void>
    /** The confirm button's label; default Delete (Withdraw, Revoke...). */
    readonly ConfirmLabel?: string
    /** When set, the dialog also asks why (a withdrawal records it) and Confirm needs a non-blank reason. */
    readonly ReasonLabel?: string
}

/**
 * Confirms an irreversible action by having the operator type the target's name. Confirm stays disabled until Typed
 * matches Expected exactly (surrounding spaces aside), and MismatchText says so while it does not; it then runs the
 * action inside the dialog and closes with Confirmed. Permission (a role, a capability) is the application's: a
 * derived dialog overrides IsPermitted, and adds what else its template shows (the consequences).
 */
export class NameConfirmDialogViewModel extends ShellDialogViewModel<boolean>
{
    public static readonly Confirmed = true

    private static readonly TypedProperty = 'Typed'
    private static readonly IsMatchProperty = 'IsMatch'
    private static readonly MismatchTextProperty = 'MismatchText'
    private static readonly ReasonProperty = 'Reason'
    private static readonly MismatchTemplate = 'That does not match {name} yet.'
    private static readonly PromptTemplate = 'Type {name} to confirm.'
    private static readonly NameToken = '{name}'
    private static readonly DeleteLabel = 'Delete'
    private static readonly NoText = ''

    private typed = NameConfirmDialogViewModel.NoText
    private reason = NameConfirmDialogViewModel.NoText

    public constructor(session: IShellSessionExpiry, dialogs: DialogService, private readonly request: NameConfirmRequest)
    {
        super(session, dialogs)
    }

    public get Expected(): string
    {
        return this.request.Expected
    }

    public get Message(): string
    {
        return this.request.Message
    }

    public get ConfirmLabel(): string
    {
        return this.request.ConfirmLabel ?? NameConfirmDialogViewModel.DeleteLabel
    }

    public get ReasonLabel(): string
    {
        return this.request.ReasonLabel ?? NameConfirmDialogViewModel.NoText
    }

    public get Typed(): string
    {
        return this.typed
    }

    public set Typed(value: string)
    {
        const N = NameConfirmDialogViewModel
        const wasMatch = this.IsMatch
        const wasMismatch = this.MismatchText
        this.SetField(N.TypedProperty, this.typed, value, v => { this.typed = v })
        this.RaisePropertyChanged(N.IsMatchProperty, wasMatch, this.IsMatch)
        this.RaisePropertyChanged(N.MismatchTextProperty, wasMismatch, this.MismatchText)
    }

    /** Surrounding spaces (a stray paste) do not count; everything else must match exactly. */
    public get IsMatch(): boolean
    {
        return this.typed.trim() === this.request.Expected
    }

    /** Why Confirm is still disabled once something has been typed: a dialog's button gives no other hint. */
    public get MismatchText(): string
    {
        const N = NameConfirmDialogViewModel
        return this.typed.trim().length === 0 || this.IsMatch ? N.NoText : N.MismatchTemplate.replace(N.NameToken, this.request.Expected)
    }

    public get PromptText(): string
    {
        return NameConfirmDialogViewModel.PromptTemplate.replace(NameConfirmDialogViewModel.NameToken, this.request.Expected)
    }

    /** Whether the dialog asks for a reason (its template shows the field). */
    public get RequiresReason(): boolean
    {
        return this.ReasonLabel.length > 0
    }

    public get Reason(): string
    {
        return this.reason
    }

    public set Reason(value: string)
    {
        this.SetField(NameConfirmDialogViewModel.ReasonProperty, this.reason, value, v => { this.reason = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.IsMatch && (!this.RequiresReason || this.reason.trim().length > 0)
    }

    protected override async SubmitCore(): Promise<boolean>
    {
        await this.request.Action(this.reason.trim())
        return NameConfirmDialogViewModel.Confirmed
    }
}
