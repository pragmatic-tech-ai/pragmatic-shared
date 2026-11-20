import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework'
import type { IShellSessionExpiry } from '../../dialogs/shell-dialog-view-model.js'
import { NameConfirmDialogViewModel } from '../../dialogs/name-confirm-dialog-view-model.js'
import { LiveUpdateBridge } from '../live-update-bridge.js'
import { OptionViewModel } from '../option-view-model.js'
import { FakeDialogService } from '../../tests/support.js'

class QuietSession implements IShellSessionExpiry
{
    public Expire(): void
    {
    }
}

class RefreshingSection
{
    public readonly Seen: string[] = []

    public async Refresh(event: string): Promise<void>
    {
        this.Seen.push(event)
    }
}

/** What an application writes: which active service is its section, and what a section does with an event. */
class SectionBridge extends LiveUpdateBridge<string, RefreshingSection>
{
    public constructor(nav: NavigationService)
    {
        super(nav)
    }

    protected IsSection(service: unknown): service is RefreshingSection
    {
        return service instanceof RefreshingSection
    }

    protected async Deliver(section: RefreshingSection, event: string): Promise<void>
    {
        await section.Refresh(event)
    }
}

/** A NavigationService whose active service the test sets. */
class SettableNavigation extends NavigationService
{
    public Active: unknown = undefined

    public constructor()
    {
        super(new ServiceProvider())
    }

    public override get ActiveService(): never
    {
        return this.Active as never
    }
}

describe('OptionViewModel', () =>
{
    it('carries a value and the label a ComboBox shows', () =>
    {
        const option = new OptionViewModel(42, 'Forty-two')
        assert.equal(option.Value, 42)
        assert.equal(option.Label, 'Forty-two')
    })
})

describe('NameConfirmDialogViewModel', () =>
{
    const Dialogs = (): FakeDialogService => new FakeDialogService(new ServiceProvider())

    it('enables Confirm only once the typed name matches (surrounding spaces aside), saying why until then', () =>
    {
        const dialog = new NameConfirmDialogViewModel(new QuietSession(), Dialogs(), { Expected: 'acme', Message: 'Deletes acme.', Action: async () => undefined })
        assert.equal(dialog.PromptText, 'Type acme to confirm.')
        assert.equal(dialog.ConfirmLabel, 'Delete')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        assert.equal(dialog.MismatchText, '')
        dialog.Typed = 'acm'
        assert.equal(dialog.MismatchText, 'That does not match acme yet.')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Typed = ' acme '
        assert.equal(dialog.IsMatch, true)
        assert.equal(dialog.MismatchText, '')
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
    })

    it('with a reason label it needs a reason, which the action receives trimmed', async () =>
    {
        const reasons: string[] = []
        const dialog = new NameConfirmDialogViewModel(new QuietSession(), Dialogs(), { Expected: 'acme', Message: 'm', ConfirmLabel: 'Withdraw', ReasonLabel: 'Why', Action: async reason => { reasons.push(reason) } })
        dialog.Typed = 'acme'
        assert.equal(dialog.RequiresReason, true)
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Reason = '  moved on  '
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        const opened = dialog.Open('Withdraw acme')
        await dialog.Confirm()
        assert.equal(await opened, NameConfirmDialogViewModel.Confirmed)
        assert.deepEqual(reasons, ['moved on'])
    })
})

describe('LiveUpdateBridge', () =>
{
    it('hands an event to the active service when it is one of the application\'s sections, and to nothing else', async () =>
    {
        const nav = new SettableNavigation()
        const bridge = new SectionBridge(nav)
        await bridge.OnEvent('ignored: nothing active')
        const section = new RefreshingSection()
        nav.Active = { Refresh: async () => assert.fail('not a section') }
        await bridge.OnEvent('ignored: another service')
        nav.Active = section
        await bridge.OnEvent('changed')
        assert.deepEqual(section.Seen, ['changed'])
        assert.equal(bridge.ActiveSection(), section)
    })
})
