/** "Drop all shell state and start over": a 401, a logout or a sign-in reloads the page, so nothing outlives a session. */
export interface IPageReloader
{
    Reload(): void
}

/** Sends the browser to another page of the own origin (the OIDC begin redirect). */
export interface IPageNavigator
{
    Assign(url: string): void
}

/** The page's own location, for building socket URLs. */
export interface IPageLocation
{
    readonly protocol: string
    readonly host: string
}

/** The real browser page. */
export class BrowserPage implements IPageReloader, IPageNavigator
{
    public Reload(): void
    {
        window.location.reload()
    }

    public Assign(url: string): void
    {
        window.location.assign(url)
    }

    public static get Location(): IPageLocation
    {
        return window.location
    }
}
