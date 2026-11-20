import { AppHost, AppHostConfig, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'

/** A real AppHost on a loopback port serving the routes a test declares. */
export class ContractHost
{
    public readonly Routes = new RouteTable()
    private host: AppHost | undefined

    public get BaseUrl(): string
    {
        return 'http://127.0.0.1:' + (this.host as AppHost).Address().port
    }

    public async Start(): Promise<this>
    {
        this.host = new AppHost(new AppHostConfig(), { Routes: this.Routes })
        await this.host.Listen(0, '127.0.0.1')
        return this
    }

    public async Stop(): Promise<void>
    {
        await this.host?.Close()
    }
}
