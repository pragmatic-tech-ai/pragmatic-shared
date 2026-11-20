import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ContentPresenter, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { ContentControl } from '@pragmatic-tech-ai/mural/framework'
import { HeadlessTarget } from '@pragmatic-tech-ai/mural/visual-engine'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { app } from './consumer/sign-in.mu.js'

/** Mounts the consumer sign-in application on a headless target and walks what it rendered. */
class RenderedSignIn
{
    private static readonly Width = 1024
    private static readonly Height = 768

    public static Mount(): Visual
    {
        const target = new HeadlessTarget(RenderedSignIn.Width, RenderedSignIn.Height)
        app.initialize(target as never)
        target.Flush()
        return app.Resources.Root as Visual
    }

    public static Texts(visual: Visual, found: string[] = []): string[]
    {
        if (visual instanceof TextBlock && typeof visual.Text === 'string' && visual.Text.length > 0)
        {
            found.push(visual.Text)
        }
        for (const child of RenderedSignIn.Children(visual))
        {
            RenderedSignIn.Texts(child, found)
        }
        return found
    }

    public static HasPresenter(visual: Visual): boolean
    {
        return visual instanceof ContentPresenter || RenderedSignIn.Children(visual).some(child => RenderedSignIn.HasPresenter(child))
    }

    private static Children(visual: Visual): readonly Visual[]
    {
        return (visual as unknown as { visualChildren: readonly Visual[] }).visualChildren
    }
}

// A sign-in application whose x:root is a bare ContentControl over the host's page renders the shell's sign-in view
// (it rendered nothing before Mural 0.67.2: a parentless root never resolved its theme Style, so it had no Template).
describe('a consumer sign-in application rooted in a ContentControl', () =>
{
    it('renders the shell sign-in page through the root ContentControl', () =>
    {
        const root = RenderedSignIn.Mount()
        assert.ok(root instanceof ContentControl)
        assert.ok(RenderedSignIn.HasPresenter(root), 'the root got its template (a ContentPresenter)')
        const texts = RenderedSignIn.Texts(root)
        assert.ok(texts.includes('Fixture Console'), texts.join(' | '))
        assert.ok(texts.includes('Sign in'), texts.join(' | '))
        assert.ok(texts.includes('Sign in with password'), texts.join(' | '))
    })
})
