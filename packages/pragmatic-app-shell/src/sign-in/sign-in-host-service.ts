import { ServiceBase, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppSessionClient } from '../api/app-session-client.js'
import { BrowserPage } from '../browser/browser-page.js'
import type { AppShellConfig } from '../config/app-shell-config.js'
import { SignInPageViewModel } from './sign-in-page-view-model.js'

/**
 * Hosts the sign-in page for an application's sign-in .mu (the small application booted when there is no session):
 * its root binds `DataContext = $service(<the derived host>).Page`, and AppShellResources renders the page. An
 * application derives one with its configuration, e.g. `constructor(p) { super(p, PlatformShell.Config) }`, and
 * registers it with its own ServiceKey.
 */
export abstract class SignInHostService extends ServiceBase
{
    private readonly page: SignInPageViewModel

    protected constructor(provider: IServiceProvider, config: AppShellConfig)
    {
        super(provider)
        this.page = new SignInPageViewModel(config, new AppSessionClient(config), new BrowserPage())
    }

    public get Page(): SignInPageViewModel
    {
        return this.page
    }
}
