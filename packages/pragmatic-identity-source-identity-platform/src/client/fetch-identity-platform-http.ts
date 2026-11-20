import { IdentityPlatformHttpResponse } from "./identity-platform-http.js";
import type { IIdentityPlatformHttp } from "./identity-platform-http.js";

/**
 * IIdentityPlatformHttp over fetch (browser-safe). The fetch is always invoked with the global object as its receiver,
 * never as a method of this or another object: the browser's fetch throws "Illegal invocation" when called with any
 * other `this`, so an unbound `window.fetch` handed in works as is. Without one, the global fetch is read at call time.
 */
export class FetchIdentityPlatformHttp implements IIdentityPlatformHttp
{
    private static readonly PostMethod = "POST";
    private static readonly ContentTypeHeader = "content-type";
    private static readonly JsonContentType = "application/json";

    public constructor(private readonly fetchFn: typeof fetch | null = null)
    {
    }

    public async PostJson(url: string, body: unknown): Promise<IdentityPlatformHttpResponse>
    {
        const init: RequestInit = {
            method: FetchIdentityPlatformHttp.PostMethod,
            headers: { [FetchIdentityPlatformHttp.ContentTypeHeader]: FetchIdentityPlatformHttp.JsonContentType },
            body: JSON.stringify(body),
        };
        const send = this.fetchFn ?? globalThis.fetch;
        const response = await Reflect.apply(send, globalThis, [url, init]) as Response;
        const json: unknown = await response.json().catch(() => null);
        return new IdentityPlatformHttpResponse(response.status, json);
    }
}
