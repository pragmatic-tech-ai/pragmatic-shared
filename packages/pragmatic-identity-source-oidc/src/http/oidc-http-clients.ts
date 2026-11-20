import { CaTrustingHttpClient } from "./ca-trusting-http-client.js";
import { FetchHttpClient } from "./fetch-http-client.js";
import type { IHttpClient } from "./http-client.js";

/**
 * The HTTP client of an OIDC path from its CA setting: plain fetch (the public roots) when no CA bundle file is
 * configured, the CA-trusting client over the file otherwise (a realm on a private CA).
 */
export class OidcHttpClients
{
    private static readonly NoFile = "";

    public static Create(caBundleFile: string | undefined): IHttpClient
    {
        return caBundleFile === undefined || caBundleFile.trim() === OidcHttpClients.NoFile
            ? new FetchHttpClient()
            : CaTrustingHttpClient.FromFile(caBundleFile.trim());
    }
}
