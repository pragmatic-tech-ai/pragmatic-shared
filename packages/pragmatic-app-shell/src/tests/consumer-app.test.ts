import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ContentControl } from '@pragmatic-tech-ai/mural/framework/base/content-control.js'
import { AppShellResources, SignInPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { app } from './consumer/sign-in.mu.js'
import { FixtureSignInHost } from './consumer/fixture-sign-in-host.js'

// A consumer application compiled against the package's built entry (dist), as an application imports it.
describe('a consumer sign-in application', () =>
{
    it('registers its host, whose page is the shell sign-in page with its configuration', () =>
    {
        const host = app.Services.getRequired(FixtureSignInHost.Key)
        assert.ok(host.Page instanceof SignInPageViewModel)
        assert.equal(host.Page.ProductName, 'Fixture Console')
        assert.equal(host.Page.OffersBoth, true)
    })

    it('merges the shell views, so the page renders through the shell template', () =>
    {
        assert.ok(app.Resources.Get(SignInPageViewModel) !== undefined)
        const expected = AppShellResources.Clone()
        for (const [key] of expected.Entries())
        {
            assert.ok(app.Resources.Get(key) !== undefined, String(key))
        }
        assert.ok(app.Resources.Root instanceof ContentControl)
    })
})
