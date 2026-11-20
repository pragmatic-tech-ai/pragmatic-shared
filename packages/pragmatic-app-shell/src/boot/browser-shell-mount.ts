import { Density, ThemeManager, type Application } from '@pragmatic-tech-ai/mural/runtime'
import { HtmlTarget } from '@pragmatic-tech-ai/mural/visual-engine'

/** Mounts a compiled Mural application into the page's root element at Compact density (the consoles' density). */
export class BrowserShellMount
{
    public static readonly DefaultRootId = 'app'

    private static readonly MissingRoot = 'BrowserShellMount: root element missing: #'

    public static Mount(app: Application, rootId: string = BrowserShellMount.DefaultRootId, density: Density = Density.Compact): void
    {
        const root = document.getElementById(rootId)
        if (root === null)
        {
            throw new Error(BrowserShellMount.MissingRoot + rootId)
        }
        ThemeManager.Density = density
        app.initialize(new HtmlTarget(root))
    }
}
