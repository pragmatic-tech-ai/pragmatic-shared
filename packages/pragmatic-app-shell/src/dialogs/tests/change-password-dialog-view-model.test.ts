import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChangePasswordDialogViewModel } from '../change-password-dialog-view-model.js'
import { SessionKit } from '../../session/tests/session-kit.js'
import { Deferred, RoutedFetch, Tick } from '../../tests/support.js'

class PasswordKit
{
    public static readonly Current = 'current-password'
    public static readonly Next = 'a-new-password-1'
    public static readonly Changed = { ok: true, otherSessionsEnded: true }

    public static Fill(dialog: ChangePasswordDialogViewModel, current: string = PasswordKit.Current, next: string = PasswordKit.Next, confirm: string = next): void
    {
        dialog.CurrentPassword = current
        dialog.NewPassword = next
        dialog.ConfirmPassword = confirm
    }

    public static Answering(kit: SessionKit, answer: (body: unknown) => Promise<Response> | Response): SessionKit
    {
        kit.Fetch.On('POST', SessionKit.PasswordPath, answer)
        return kit
    }
}

describe('ChangePasswordDialogViewModel', () =>
{
    it('Confirm needs the current password, a new one at the configured length that differs from it, and a matching confirmation', () =>
    {
        const kit = new SessionKit({ MinPasswordLength: 14 })
        const dialog = new ChangePasswordDialogViewModel(kit.Service, kit.UseDialogs())
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Current, 'fourteen-chars')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        PasswordKit.Fill(dialog, '', 'fourteen-chars')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Current, 'thirteen-char')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, PasswordKit.Current, 'fourteen-chars', 'fourteen-charsx')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        PasswordKit.Fill(dialog, 'fourteen-chars', 'fourteen-chars')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
    })

    it('says inline why the new password or its confirmation is not acceptable, and nothing before typing', () =>
    {
        const kit = new SessionKit()
        const dialog = new ChangePasswordDialogViewModel(kit.Service, kit.UseDialogs())
        const raised: string[] = []
        dialog.PropertyChanged('MismatchText').subscribe(e => { raised.push(String(e.newValue)) })
        assert.equal(dialog.NewPasswordText, '')
        assert.equal(dialog.MismatchText, '')
        dialog.NewPassword = 'short'
        assert.equal(dialog.NewPasswordText, 'Use at least 12 characters.')
        dialog.CurrentPassword = PasswordKit.Next
        dialog.NewPassword = PasswordKit.Next
        assert.equal(dialog.NewPasswordText, 'The new password must differ from the current one.')
        dialog.CurrentPassword = PasswordKit.Current
        assert.equal(dialog.NewPasswordText, '')
        dialog.ConfirmPassword = 'a-new-pass'
        assert.equal(dialog.MismatchText, 'The two new passwords do not match.')
        dialog.ConfirmPassword = PasswordKit.Next
        assert.equal(dialog.MismatchText, '')
        assert.deepEqual(raised, ['The two new passwords do not match.', ''])
    })

    it('posts the three passwords and resolves with the reply; the email is the signed-in one', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(200, PasswordKit.Changed))
        const dialog = new ChangePasswordDialogViewModel(kit.Service, kit.UseDialogs())
        assert.equal(dialog.Email, SessionKit.Email)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        assert.deepEqual(await opened, PasswordKit.Changed)
        const call = kit.Fetch.Calls.find(c => c.Url === SessionKit.PasswordPath)!
        assert.deepEqual(JSON.parse(String(call.Init.body)), { currentPassword: PasswordKit.Current, newPassword: PasswordKit.Next, confirmPassword: PasswordKit.Next })
    })

    it('clears every password once it closes: changed, cancelled, or dismissed', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(200, PasswordKit.Changed))
        const dialogs = kit.UseDialogs()
        for (const close of ['confirm', 'cancel', 'dismiss'])
        {
            const dialog = new ChangePasswordDialogViewModel(kit.Service, dialogs)
            const opened = dialog.Open('Change your password')
            PasswordKit.Fill(dialog)
            if (close === 'confirm')
            {
                dialog.ConfirmCommand.Execute()
            }
            else if (close === 'cancel')
            {
                dialog.CancelCommand.Execute()
            }
            else
            {
                dialogs.Dismiss()
            }
            await Tick.Settle()
            await opened
            assert.deepEqual([dialog.CurrentPassword, dialog.NewPassword, dialog.ConfirmPassword], ['', '', ''], close)
        }
    })

    it('a wrong current password (403) keeps the dialog open with the reason; the session does not expire', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(403, { error: 'The current password is not correct.' }))
        const dialogs = kit.UseDialogs()
        const dialog = new ChangePasswordDialogViewModel(kit.Service, dialogs)
        void dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        assert.equal(dialog.ErrorText, 'The current password is not correct.')
        assert.equal(dialogs.IsOpen, true)
        assert.equal(kit.Page.Reloads, 0)
        dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(dialog.CurrentPassword, '')
    })

    it('the session Change password command opens the dialog and, once changed, says so in the header', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(200, PasswordKit.Changed))
        const dialogs = kit.UseDialogs()
        const done = kit.Service.ChangePassword()
        await Tick.Next()
        const dialog = dialogs.Last as ChangePasswordDialogViewModel
        assert.ok(dialog instanceof ChangePasswordDialogViewModel)
        assert.equal(dialogs.Shown[0].Title, 'Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(kit.Service.AccountNotice, 'Password changed. Your other sessions were signed out.')
    })

    it('a change the server only partly completed shows its warning in the header', async () =>
    {
        const warning = 'Your password is changed. Sign in again with the new password.'
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(200, { ok: true, otherSessionsEnded: false, warning }))
        const dialogs = kit.UseDialogs()
        const done = kit.Service.ChangePassword()
        await Tick.Next()
        const dialog = dialogs.Last as ChangePasswordDialogViewModel
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await done
        assert.equal(kit.Service.AccountNotice, warning)
    })

    it('while the change is submitting a 401 elsewhere does not expire the session; once done it is checked once and kept', async () =>
    {
        const held = new Deferred<void>()
        const kit = PasswordKit.Answering(new SessionKit().SessionAlive(true), async () => { await held.Promise; return RoutedFetch.Json(200, PasswordKit.Changed) })
        kit.Fetch.On('GET', '/api/things', () => RoutedFetch.Json(401, {}))
        const dialog = new ChangePasswordDialogViewModel(kit.Service, kit.UseDialogs())
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await Tick.Settle()
        // A page request answered 401 between the server's revoke and the fresh cookie.
        await (kit.Client as unknown as { Get(route: string): Promise<unknown> }).Get('/api/things').catch(() => undefined)
        assert.equal(kit.Page.Reloads, 0)
        held.Resolve()
        await opened
        await Tick.Settle()
        assert.equal(kit.Fetch.Count('GET', '/api/session'), 1)
        assert.equal(kit.Page.Reloads, 0)
    })

    it('a 401 answering the change itself, with the session gone afterwards, expires once the change is done', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit().SessionAlive(false), () => RoutedFetch.Json(401, { error: 'Not signed in' }))
        const dialogs = kit.UseDialogs()
        const dialog = new ChangePasswordDialogViewModel(kit.Service, dialogs)
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        assert.equal(await opened, undefined)
        await Tick.Settle()
        assert.equal(kit.Page.Reloads, 1)
        assert.equal(dialogs.IsOpen, false)
    })

    it('without a 401 during the change nothing is re-checked, and expiry works again afterwards', async () =>
    {
        const kit = PasswordKit.Answering(new SessionKit(), () => RoutedFetch.Json(200, PasswordKit.Changed))
        const dialog = new ChangePasswordDialogViewModel(kit.Service, kit.UseDialogs())
        const opened = dialog.Open('Change your password')
        PasswordKit.Fill(dialog)
        dialog.ConfirmCommand.Execute()
        await opened
        assert.equal(kit.Fetch.Count('GET', '/api/session'), 0)
        kit.Service.Expire()
        assert.equal(kit.Page.Reloads, 1)
    })

    it('a cancelled change leaves the header notice empty', async () =>
    {
        const kit = new SessionKit()
        const dialogs = kit.UseDialogs()
        const done = kit.Service.ChangePassword()
        await Tick.Next()
        dialogs.Dismiss()
        await done
        assert.equal(kit.Service.AccountNotice, '')
    })
})
