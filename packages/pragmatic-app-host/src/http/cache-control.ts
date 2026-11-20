import type { ServerResponse } from 'node:http'

/** Cache-Control for answers that must never be stored (session state, sign-in redirects, tickets). */
export class CacheControl
{
    private static readonly Header = 'Cache-Control'
    private static readonly NoStoreValue = 'no-store'

    public static NoStore(res: ServerResponse): void
    {
        res.setHeader(CacheControl.Header, CacheControl.NoStoreValue)
    }
}
