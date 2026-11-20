import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppShellBoot, BootOutcome, type IShellApplications } from '../app-shell-boot.js'
import { AppSessionClient } from '../../api/app-session-client.js'
import type { AppSession } from '../../api/app-session.js'
import { AppShellConfig } from '../../config/app-shell-config.js'
import { SignInMethod } from '../../config/sign-in-method.js'
import { FakePage, FetchStub } from '../../tests/support.js'

class FakeApp
{
    public constructor(public readonly Name: string)
    {
    }
}

// Records what the boot did with the two applications, in order.
class FakeApplications implements IShellApplications<FakeApp>
{
    public readonly Steps: string[] = []
    public Session: AppSession | undefined

    public async LoadSignIn(): Promise<FakeApp>
    {
        this.Steps.push('load sign-in')
        return new FakeApp('sign-in')
    }

    public async LoadShell(): Promise<FakeApp>
    {
        this.Steps.push('load shell')
        return new FakeApp('shell')
    }

    public ShowSignInError(app: FakeApp, message: string): void
    {
        this.Steps.push(`error on ${app.Name}: ${message}`)
    }

    public ShowSignInFailed(app: FakeApp, message: string): void
    {
        this.Steps.push(`failed on ${app.Name}: ${message}`)
    }

    public async StartShell(app: FakeApp, session: AppSession, _client: AppSessionClient): Promise<void>
    {
        this.Session = session
        this.Steps.push(`start ${app.Name}`)
    }

    public Mount(app: FakeApp): void
    {
        this.Steps.push(`mount ${app.Name}`)
    }
}

class Kit
{
    public readonly Apps = new FakeApplications()
    public readonly Page = new FakePage()

    public Boot(fetch: FetchStub, methods: SignInMethod[] = [SignInMethod.Oidc], search = ''): AppShellBoot<FakeApp>
    {
        const client = new AppSessionClient(new AppShellConfig({ ProductName: 'Tenant Admin', SignInMethods: methods }), fetch.Fetch)
        return new AppShellBoot(client, this.Apps, this.Page, search)
    }
}

describe('AppShellBoot', () =>
{
    it('with a session starts the shell with it, then mounts it', async () =>
    {
        const kit = new Kit()
        const outcome = await kit.Boot(new FetchStub().Json(200, { subject: 's', claims: { email: ['a@x.test'] } })).Run()
        assert.equal(outcome, BootOutcome.Shell)
        assert.deepEqual(kit.Apps.Steps, ['load shell', 'start shell', 'mount shell'])
        assert.equal(kit.Apps.Session?.Email, 'a@x.test')
    })

    it('without a session sends an OIDC-only application straight to the identity provider', async () =>
    {
        const kit = new Kit()
        const outcome = await kit.Boot(new FetchStub().Json(401, { error: 'Not signed in' })).Run()
        assert.equal(outcome, BootOutcome.Redirected)
        assert.deepEqual(kit.Page.Assigned, ['/auth/oidc/begin'])
        assert.deepEqual(kit.Apps.Steps, [])
    })

    it('back from a failed sign-in (?sign_in=failed) an OIDC-only application shows the sign-in page saying so, not the identity provider again', async () =>
    {
        const kit = new Kit()
        const outcome = await kit.Boot(new FetchStub().Json(401, {}), [SignInMethod.Oidc], '?sign_in=failed').Run()
        assert.equal(outcome, BootOutcome.SignInFailed)
        assert.deepEqual(kit.Apps.Steps, ['load sign-in', "failed on sign-in: Signing in to Tenant Admin didn't complete.", 'mount sign-in'])
        assert.deepEqual(kit.Page.Assigned, [])
    })

    it('the failure marker is ignored with a session, and another query does not stop the redirect', async () =>
    {
        const signedIn = new Kit()
        assert.equal(await signedIn.Boot(new FetchStub().Json(200, { subject: 's', claims: {} }), [SignInMethod.Oidc], '?sign_in=failed').Run(), BootOutcome.Shell)
        const other = new Kit()
        assert.equal(await other.Boot(new FetchStub().Json(401, {}), [SignInMethod.Oidc], '?sign_in=ok').Run(), BootOutcome.Redirected)
    })

    it('without a session shows the sign-in page when the application offers a password', async () =>
    {
        const kit = new Kit()
        const outcome = await kit.Boot(new FetchStub().Json(401, {}), [SignInMethod.Oidc, SignInMethod.Password]).Run()
        assert.equal(outcome, BootOutcome.SignInPage)
        assert.deepEqual(kit.Apps.Steps, ['load sign-in', 'mount sign-in'])
        assert.deepEqual(kit.Page.Assigned, [])
    })

    it('a probe that fails for another reason shows the sign-in page saying the application cannot be reached', async () =>
    {
        const kit = new Kit()
        const outcome = await kit.Boot(new FetchStub().Json(503, { error: 'Unavailable' })).Run()
        assert.equal(outcome, BootOutcome.Unreachable)
        assert.deepEqual(kit.Apps.Steps, ['load sign-in', "error on sign-in: Can't reach Tenant Admin: Unavailable", 'mount sign-in'])
        const network = new Kit()
        await network.Boot(new FetchStub().Failing(new TypeError('Failed to fetch'))).Run()
        assert.equal(network.Apps.Steps[1], "error on sign-in: Can't reach Tenant Admin: Failed to fetch")
    })
})
