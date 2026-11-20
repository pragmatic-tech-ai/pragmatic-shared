/** An answer of the identitytoolkit REST API: the HTTP status and the parsed JSON body (null when not JSON). */
export class IdentityPlatformHttpResponse
{
    private static readonly OkMin = 200;
    private static readonly OkMax = 299;

    public constructor(public readonly Status: number, public readonly Body: unknown)
    {
    }

    public get Ok(): boolean
    {
        return this.Status >= IdentityPlatformHttpResponse.OkMin && this.Status <= IdentityPlatformHttpResponse.OkMax;
    }
}

/**
 * How IdentityPlatformRestClient reaches the identitytoolkit REST API: one JSON POST. The default is
 * FetchIdentityPlatformHttp; tests and hosts with their own transport inject another.
 */
export interface IIdentityPlatformHttp
{
    PostJson(url: string, body: unknown): Promise<IdentityPlatformHttpResponse>;
}
