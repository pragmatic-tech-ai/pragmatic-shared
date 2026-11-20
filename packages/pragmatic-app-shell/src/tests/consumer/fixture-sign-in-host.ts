import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { AppShellConfig, SignInHostService, SignInMethod } from '@pragmatic-tech-ai/pragmatic-app-shell'

// A consumer application's sign-in host, written the way an application writes one: against the published entry.
export class FixtureSignInHost extends SignInHostService
{
    public static readonly Key = new ServiceKey<FixtureSignInHost>('FixtureSignInHost')

    private static readonly Config = new AppShellConfig({ ProductName: 'Fixture Console', SignInMethods: [SignInMethod.Oidc, SignInMethod.Password] })

    public constructor(provider: IServiceProvider)
    {
        super(provider, FixtureSignInHost.Config)
    }
}
