import type { IHttpClient } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { FakeIdentityPlatform } from "./fake-identity-platform.js";

/** Serves the fake's JWKS at Google's securetoken JWKS URL and counts the fetches (to prove caching). */
export class FakeIdentityPlatformHttp implements IHttpClient
{
    private static readonly UnknownUrlMessage = "FakeIdentityPlatformHttp: unknown URL";
    private static readonly UnavailableMessage = "FakeIdentityPlatformHttp: JWKS unavailable";
    private static readonly NoPostMessage = "FakeIdentityPlatformHttp: no form posts";

    public JwksFetches = 0;
    public Unavailable = false;

    public constructor(private readonly platform: FakeIdentityPlatform)
    {
    }

    public async GetJson(url: string, _bearer?: string): Promise<unknown>
    {
        if (url !== FakeIdentityPlatform.SecuretokenJwksUri)
        {
            throw new Error(FakeIdentityPlatformHttp.UnknownUrlMessage);
        }
        this.JwksFetches++;
        if (this.Unavailable)
        {
            throw new Error(FakeIdentityPlatformHttp.UnavailableMessage);
        }
        return this.platform.Jwks();
    }

    public async PostForm(_url: string, _fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        throw new Error(FakeIdentityPlatformHttp.NoPostMessage);
    }
}
