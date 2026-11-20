import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Key } from '@pragmatic-tech-ai/mural/runtime'
import { SignInPageViewModel, type ISignInClient } from '../sign-in-page-view-model.js'
import { AppShellConfig } from '../../config/app-shell-config.js'
import { SignInMethod } from '../../config/sign-in-method.js'
import type { IPageNavigator } from '../../browser/browser-page.js'
import { ApiError } from '../../api/api-error.js'
import { Deferred, FakePage, Tick } from '../../tests/support.js'

class FakeSignInClient implements ISignInClient
{
    public readonly Logins: Array<[string, string]> = []
    public Begun = 0
    public Next: Deferred<void> | undefined
    public Failure: Error | undefined

    public async PasswordLogin(email: string, password: string): Promise<void>
    {
        this.Logins.push([email, password])
        if (this.Next !== undefined)
        {
            await this.Next.Promise
        }
        if (this.Failure !== undefined)
        {
            throw this.Failure
        }
    }

    public BeginOidcSignIn(_navigator: IPageNavigator): void
    {
        this.Begun++
    }
}

class Kit
{
    public readonly Client = new FakeSignInClient()
    public readonly Page = new FakePage()
    public readonly Vm: SignInPageViewModel

    public constructor(methods: SignInMethod[] = [SignInMethod.Oidc, SignInMethod.Password])
    {
        this.Vm = new SignInPageViewModel(new AppShellConfig({ ProductName: 'Platform Admin', SignInMethods: methods }), this.Client, this.Page)
    }

    public Fill(email: string = ' op@example.test ', password: string = 'pw'): void
    {
        this.Vm.Email = email
        this.Vm.Password = password
    }
}

describe('SignInPageViewModel', () =>
{
    it('shows the product name and exactly the sign-in methods the application offers', () =>
    {
        const both = new Kit().Vm
        assert.equal(both.ProductName, 'Platform Admin')
        assert.equal(both.OffersOidc, true)
        assert.equal(both.OffersPassword, true)
        assert.equal(both.OffersBoth, true)
        const oidc = new Kit([SignInMethod.Oidc]).Vm
        assert.equal(oidc.OffersPassword, false)
        assert.equal(oidc.OffersBoth, false)
        assert.equal(oidc.PasswordSignInCommand.CanExecute(), false)
        const password = new Kit([SignInMethod.Password]).Vm
        assert.equal(password.OffersOidc, false)
        assert.equal(password.SignInCommand.CanExecute(), false)
    })

    it('OIDC sign-in hands the page to the client once and stays busy while the browser leaves', () =>
    {
        const kit = new Kit()
        kit.Vm.SignInCommand.Execute()
        assert.equal(kit.Client.Begun, 1)
        assert.equal(kit.Vm.IsBusy, true)
        assert.equal(kit.Vm.SignInCommand.CanExecute(), false)
        kit.Vm.SignInCommand.Execute()
        assert.equal(kit.Client.Begun, 1)
    })

    it('password sign-in needs an email and a password, trims the email, and reloads on success', async () =>
    {
        const kit = new Kit()
        assert.equal(kit.Vm.PasswordSignInCommand.CanExecute(), false)
        kit.Fill(' op@example.test ', '')
        assert.equal(kit.Vm.PasswordSignInCommand.CanExecute(), false)
        kit.Fill()
        assert.equal(kit.Vm.PasswordSignInCommand.CanExecute(), true)
        await kit.Vm.PasswordSignIn()
        assert.deepEqual(kit.Client.Logins, [['op@example.test', 'pw']])
        assert.equal(kit.Page.Reloads, 1)
        assert.equal(kit.Vm.IsBusy, true)
    })

    it('a failed password sign-in says why, clears the password and frees the form', async () =>
    {
        const kit = new Kit()
        kit.Client.Failure = new ApiError(401, 'Invalid credentials')
        kit.Fill()
        await kit.Vm.PasswordSignIn()
        assert.equal(kit.Vm.ErrorText, 'Invalid credentials')
        assert.equal(kit.Vm.Password, '')
        assert.equal(kit.Vm.Email, ' op@example.test ')
        assert.equal(kit.Vm.IsBusy, false)
        assert.equal(kit.Page.Reloads, 0)
    })

    it('does not submit twice while a sign-in is in flight', async () =>
    {
        const kit = new Kit()
        kit.Client.Next = new Deferred<void>()
        kit.Fill()
        const first = kit.Vm.PasswordSignIn()
        assert.equal(kit.Vm.IsBusy, true)
        assert.equal(kit.Vm.PasswordSignInCommand.CanExecute(), false)
        await kit.Vm.PasswordSignIn()
        kit.Client.Next.Resolve()
        await first
        assert.equal(kit.Client.Logins.length, 1)
    })

    it('Enter submits the password form; other keys and handled keys are left alone', async () =>
    {
        const kit = new Kit()
        kit.Fill()
        const other = { Key: Key.Tab, Handled: false }
        kit.Vm.SubmitKeyCommand.Execute(other)
        assert.equal(other.Handled, false)
        const handled = { Key: Key.Return, Handled: true }
        kit.Vm.SubmitKeyCommand.Execute(handled)
        assert.equal(kit.Client.Logins.length, 0)
        const enter = { Key: Key.Return, Handled: false }
        kit.Vm.SubmitKeyCommand.Execute(enter)
        assert.equal(enter.Handled, true)
        await Tick.Settle()
        assert.equal(kit.Client.Logins.length, 1)
    })

    it('Enter does nothing when the application offers no password sign-in', async () =>
    {
        const kit = new Kit([SignInMethod.Oidc])
        kit.Fill()
        const enter = { Key: Key.Return, Handled: false }
        kit.Vm.SubmitKeyCommand.Execute(enter)
        await Tick.Settle()
        assert.equal(enter.Handled, false)
        assert.equal(kit.Client.Logins.length, 0)
    })

    it('shows why the page could not proceed, and Try again reloads', () =>
    {
        const kit = new Kit()
        const raised: string[] = []
        kit.Vm.PropertyChanged('ErrorText').subscribe(e => { raised.push(String(e.newValue)) })
        kit.Vm.ShowError("Can't reach Platform Admin: down")
        assert.equal(kit.Vm.ErrorText, "Can't reach Platform Admin: down")
        assert.deepEqual(raised, ["Can't reach Platform Admin: down"])
        kit.Vm.RetryCommand.Execute()
        assert.equal(kit.Page.Reloads, 1)
        assert.equal(kit.Vm.RetryCommand.CanExecute(), false)
    })

    it('after a failed OIDC sign-in, Try again begins the sign-in again instead of reloading the failure', () =>
    {
        const kit = new Kit([SignInMethod.Oidc])
        kit.Vm.ShowSignInFailed('Sign-in did not complete.')
        assert.equal(kit.Vm.ErrorText, 'Sign-in did not complete.')
        assert.equal(kit.Vm.RetryCommand.CanExecute(), true)
        kit.Vm.RetryCommand.Execute()
        assert.equal(kit.Client.Begun, 1)
        assert.equal(kit.Page.Reloads, 0)
        assert.equal(kit.Vm.IsBusy, true)
    })
})
