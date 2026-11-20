import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceProvider, Style } from '@pragmatic-tech-ai/mural/runtime'
import { DataTemplate } from '@pragmatic-tech-ai/mural/basic'
import * as Shell from '../index.js'
import { FakeDialogService, FakePage } from './support.js'

class Reveal extends Shell.OneTimeSecretPageViewModel
{
    public constructor()
    {
        super({ Clipboard: undefined }, 'value')
    }

    public get Title(): string
    {
        return 'Issued'
    }

    public get Notice(): string
    {
        return 'Shown once.'
    }

    public get ConfirmLabel(): string
    {
        return 'Done'
    }

    protected OnSaved(): void
    {
    }
}

// The compiled app-shell.resources.mu, through the package entry a consumer imports.
describe('AppShellResources', () =>
{
    const resources = Shell.AppShellResources.Clone()

    it('holds an implicit template for each shell view model and the submit-on-enter style', () =>
    {
        for (const type of [Shell.SignInPageViewModel, Shell.AppSessionService, Shell.ChangePasswordDialogViewModel, Shell.OneTimeSecretPageViewModel])
        {
            assert.ok(resources.Get(type) instanceof DataTemplate, type.name)
        }
        assert.ok(resources.Get('AppShellSubmitOnEnter') instanceof Style)
    })

    it('each template builds its view over the view model', () =>
    {
        const config = new Shell.AppShellConfig({ ProductName: 'Console', SignInMethods: [Shell.SignInMethod.Oidc, Shell.SignInMethod.Password] })
        const client = new Shell.AppSessionClient(config, async () => new Response(null, { status: 204 }))
        const provider = new ServiceProvider()
        const session = new Shell.AppSessionService(provider)
        session.Initialize(client, Shell.AppSession.FromWire({ subject: 's', claims: { email: ['a@x.test'] } }, config), new FakePage())
        const models: Array<[Function, unknown]> = [
            [Shell.SignInPageViewModel, new Shell.SignInPageViewModel(config, client, new FakePage())],
            [Shell.AppSessionService, session],
            [Shell.ChangePasswordDialogViewModel, new Shell.ChangePasswordDialogViewModel(session, new FakeDialogService(provider))],
            [Shell.OneTimeSecretPageViewModel, new Reveal()],
        ]
        for (const [type, model] of models)
        {
            const template = resources.Get(type) as DataTemplate
            assert.ok(template.Apply(model) !== undefined, type.name)
        }
    })
})
