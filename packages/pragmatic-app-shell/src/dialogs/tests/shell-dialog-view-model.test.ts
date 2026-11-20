import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { DialogService, type DialogOptions } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { ShellDialogViewModel, type IShellSessionExpiry } from '../shell-dialog-view-model.js'
import { ApiError } from '../../api/api-error.js'
import { FakeDialogService, Tick } from '../../tests/support.js'

class CountingSession implements IShellSessionExpiry
{
    public Expired = 0

    public Expire(): void
    {
        this.Expired++
    }
}

// A dialog whose submit waits until Release, or fails with Failure.
class HeldDialog extends ShellDialogViewModel<string>
{
    public Permitted = true
    public Failure: Error | undefined
    private release: (() => void) | undefined

    public constructor(session: IShellSessionExpiry, dialogs: DialogService, private readonly holds: boolean = true)
    {
        super(session, dialogs)
    }

    public Release(): void
    {
        this.release?.()
    }

    public Permit(next: boolean): void
    {
        this.Permitted = next
        this.RaiseCanConfirmChanged()
    }

    protected override get IsPermitted(): boolean
    {
        return this.Permitted
    }

    protected override get CanConfirm(): boolean
    {
        return true
    }

    protected override async SubmitCore(): Promise<string>
    {
        if (this.holds)
        {
            await new Promise<void>(resolve => { this.release = resolve })
        }
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
        return 'done'
    }
}

// A service whose superseded dialog settles late: a newer Show takes over at once, but the older Show's promise
// resolves only on a later tick.
class LateSettlingDialogs extends DialogService
{
    public readonly Closes: unknown[] = []
    private settle: ((value: unknown) => void) | undefined
    private superseded: ((value: unknown) => void) | undefined

    public override Show<T = unknown>(_options: DialogOptions): Promise<T | undefined>
    {
        this.superseded = this.settle
        return new Promise<T | undefined>(resolve => { this.settle = resolve as (value: unknown) => void })
    }

    public SettleSuperseded(): void
    {
        this.superseded?.(undefined)
        this.superseded = undefined
    }

    public override Close(result?: unknown): void
    {
        this.Closes.push(result)
        const settle = this.settle
        this.settle = undefined
        settle?.(result)
    }
}

describe('ShellDialogViewModel', () =>
{
    it('opens through the dialog service with itself as content, fixed width, and no scrim dismissal', async () =>
    {
        const dialogs = new FakeDialogService(new ServiceProvider())
        const dialog = new HeldDialog(new CountingSession(), dialogs, false)
        const opened = dialog.Open('Title')
        assert.equal(dialogs.Shown[0].Title, 'Title')
        assert.equal(dialogs.Shown[0].Content, dialog)
        assert.equal(dialogs.Shown[0].DismissOnScrimClick, false)
        assert.equal(dialogs.Shown[0].Width, 480)
        dialog.ConfirmCommand.Execute()
        assert.equal(await opened, 'done')
    })

    it('Confirm is off while the application says the session may not do it', () =>
    {
        const dialog = new HeldDialog(new CountingSession(), new FakeDialogService(new ServiceProvider()), false)
        dialog.Permit(false)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Permit(true)
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
    })

    it('a 401 expires the session and closes the dialog; another failure stays open with ErrorText', async () =>
    {
        const session = new CountingSession()
        const dialogs = new FakeDialogService(new ServiceProvider())
        const expired = new HeldDialog(session, dialogs, false)
        expired.Failure = new ApiError(401, 'Not signed in')
        const opened = expired.Open('A')
        expired.ConfirmCommand.Execute()
        assert.equal(await opened, undefined)
        assert.equal(session.Expired, 1)
        const failing = new HeldDialog(session, dialogs, false)
        failing.Failure = new ApiError(409, 'Already exists')
        void failing.Open('B')
        failing.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.equal(failing.ErrorText, 'Already exists')
        assert.equal(dialogs.IsOpen, true)
        assert.equal(failing.IsBusy, false)
    })

    it('a dismissal while a submit is in flight still resolves with its result; a late failure rejects Open', async () =>
    {
        const dialogs = new FakeDialogService(new ServiceProvider())
        const dialog = new HeldDialog(new CountingSession(), dialogs)
        const opened = dialog.Open('A')
        dialog.ConfirmCommand.Execute()
        await Tick.Next()
        dialogs.Dismiss()
        dialog.Release()
        assert.equal(await opened, 'done')
        const failing = new HeldDialog(new CountingSession(), dialogs)
        failing.Failure = new Error('late')
        const failed = failing.Open('B')
        failing.ConfirmCommand.Execute()
        await Tick.Next()
        dialogs.Dismiss()
        failing.Release()
        await assert.rejects(failed, /late/)
    })

    it('a submit settling while a superseding dialog is open does not close it, even before the old Show settles', async () =>
    {
        const dialogs = new LateSettlingDialogs(new ServiceProvider())
        const session = new CountingSession()
        const first = new HeldDialog(session, dialogs)
        const firstOpened = first.Open('First')
        first.ConfirmCommand.Execute()
        await Tick.Next()
        const second = new HeldDialog(session, dialogs)
        const secondOpened = second.Open('Second')
        first.Release()
        await Tick.Settle()
        assert.deepEqual(dialogs.Closes, [])
        dialogs.SettleSuperseded()
        assert.equal(await firstOpened, 'done')
        assert.deepEqual(dialogs.Closes, [])
        dialogs.Close(undefined)
        assert.equal(await secondOpened, undefined)
    })

    it('a submit settling while its own dialog is open closes it with the result', async () =>
    {
        const dialogs = new LateSettlingDialogs(new ServiceProvider())
        const dialog = new HeldDialog(new CountingSession(), dialogs)
        const opened = dialog.Open('Only')
        dialog.ConfirmCommand.Execute()
        await Tick.Next()
        dialog.Release()
        assert.equal(await opened, 'done')
        assert.deepEqual(dialogs.Closes, ['done'])
    })
})
