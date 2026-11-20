import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OneTimeSecretPageViewModel, type IClipboardSource, type IClipboardWriter } from '../one-time-secret-page-view-model.js'
import { PendingSecret } from '../../pending/holds-pending-secret.js'
import { Tick } from '../../tests/support.js'

class FakeClipboard implements IClipboardWriter
{
    public readonly Written: string[] = []

    public constructor(private readonly fails: boolean = false)
    {
    }

    public async WriteText(text: string): Promise<void>
    {
        if (this.fails)
        {
            throw new Error('denied')
        }
        this.Written.push(text)
    }
}

class ClipboardSource implements IClipboardSource
{
    public constructor(public readonly Clipboard: IClipboardWriter | undefined)
    {
    }
}

class RevealPage extends OneTimeSecretPageViewModel
{
    public SavedCalls = 0

    public constructor(source: IClipboardSource, value: string)
    {
        super(source, value)
    }

    public get Title(): string
    {
        return 'Token issued'
    }

    public get Notice(): string
    {
        return 'Shown once.'
    }

    public get ConfirmLabel(): string
    {
        return 'Back to tokens'
    }

    protected OnSaved(): void
    {
        this.SavedCalls++
    }
}

describe('OneTimeSecretPageViewModel', () =>
{
    it('holds its section while the value is shown and registers itself as a pending-secret page', () =>
    {
        const page = new RevealPage(new ClipboardSource(undefined), 's3cret')
        assert.equal(page.Value, 's3cret')
        assert.equal(page.HasPendingSecret, true)
        assert.equal(PendingSecret.IsHeldBy(page), true)
        assert.equal(page.Title, 'Token issued')
    })

    it('confirms only once "I have saved it" is ticked, then clears the value, raises the change and moves on', () =>
    {
        const page = new RevealPage(new ClipboardSource(undefined), 's3cret')
        const raised: string[] = []
        page.PropertyChanged(PendingSecret.ChangedProperty).subscribe(e => { raised.push(String(e.newValue)) })
        assert.equal(page.ConfirmSavedCommand.CanExecute(), false)
        page.ConfirmSavedCommand.Execute()
        assert.equal(page.SavedCalls, 0)
        page.Saved = true
        assert.equal(page.ConfirmSavedCommand.CanExecute(), true)
        page.ConfirmSavedCommand.Execute()
        assert.equal(page.Value, '')
        assert.equal(page.HasPendingSecret, false)
        assert.equal(PendingSecret.IsHeldBy(page), false)
        assert.deepEqual(raised, ['false'])
        assert.equal(page.SavedCalls, 1)
        assert.equal(page.ConfirmSavedCommand.CanExecute(), false)
        assert.equal(page.CopyCommand.CanExecute(), false)
    })

    it('copies the value and says so; a missing or refusing clipboard asks for a manual copy', async () =>
    {
        const clipboard = new FakeClipboard()
        const page = new RevealPage(new ClipboardSource(clipboard), 's3cret')
        page.CopyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(clipboard.Written, ['s3cret'])
        assert.equal(page.CopyStatus, 'Copied.')
        for (const source of [new ClipboardSource(undefined), new ClipboardSource(new FakeClipboard(true))])
        {
            const failing = new RevealPage(source, 'x')
            failing.CopyCommand.Execute()
            await Tick.Settle()
            assert.equal(failing.CopyStatus, 'Could not copy. Select the value and copy it by hand.')
        }
    })

    it('reads the clipboard from its source when copying, not when built (the shell may provide it later)', async () =>
    {
        const source = { Clipboard: undefined as IClipboardWriter | undefined }
        const page = new RevealPage(source, 'late')
        const clipboard = new FakeClipboard()
        source.Clipboard = clipboard
        page.CopyCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(clipboard.Written, ['late'])
    })
})
