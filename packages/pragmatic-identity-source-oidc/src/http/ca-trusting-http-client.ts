import { readFileSync } from "node:fs";
import * as https from "node:https";
import { rootCertificates } from "node:tls";
import type { IHttpClient } from "./http-client.js";

/**
 * A `node:https` relying-party HTTP client that trusts a private CA as well as the public roots (a realm IdP on a
 * private CA): the IHttpClient the OIDC paths consume (https only; discovery and keys by GET, the code exchange by form
 * POST). Its errors are fixed sentences carrying neither the URL nor the posted fields (the token POST holds the client
 * secret and the code). FromFile reads a PEM bundle (one or more certificates) from a mounted secret or config file.
 */
export class CaTrustingHttpClient implements IHttpClient
{
    private static readonly HttpsProtocol = "https:";
    private static readonly GetMethod = "GET";
    private static readonly PostMethod = "POST";
    private static readonly FormContentType = "application/x-www-form-urlencoded";
    private static readonly ContentTypeHeader = "Content-Type";
    private static readonly ContentLengthHeader = "Content-Length";
    private static readonly AuthorizationHeader = "Authorization";
    private static readonly BearerPrefix = "Bearer ";
    private static readonly Utf8 = "utf8";
    private static readonly CertificateMarker = "-----BEGIN CERTIFICATE-----";
    private static readonly DefaultPort = 443;
    private static readonly TimeoutMs = 10_000;
    private static readonly OkMin = 200;
    private static readonly OkMax = 300;
    private static readonly DataEvent = "data";
    private static readonly EndEvent = "end";
    private static readonly ErrorEvent = "error";
    private static readonly NonHttpsMessage = "oidc http client: only https URLs are permitted";
    private static readonly RequestFailedMessage = "oidc http client: request failed";
    private static readonly UnreadableBundleMessage = "oidc http client: the CA bundle file cannot be read: ";
    private static readonly NoCertificateMessage = "oidc http client: the CA bundle file holds no PEM certificate: ";

    private readonly agent: https.Agent;

    /** Trusts `ca` (PEM, one or more certificates) in addition to the public roots. */
    public constructor(ca: Buffer | string)
    {
        this.agent = new https.Agent({ ca: [...rootCertificates, ca.toString()] });
    }

    /** The client trusting the PEM bundle at `path`; throws when the file is unreadable or holds no certificate. */
    public static FromFile(path: string): CaTrustingHttpClient
    {
        const C = CaTrustingHttpClient;
        let pem: string;
        try
        {
            pem = readFileSync(path, C.Utf8);
        }
        catch
        {
            throw new Error(C.UnreadableBundleMessage + path);
        }
        if (!pem.includes(C.CertificateMarker))
        {
            throw new Error(C.NoCertificateMessage + path);
        }
        return new CaTrustingHttpClient(pem);
    }

    public GetJson(url: string, bearer?: string): Promise<unknown>
    {
        return this.Send(CaTrustingHttpClient.GetMethod, url, undefined, bearer);
    }

    public PostForm(url: string, fields: ReadonlyMap<string, string>): Promise<unknown>
    {
        return this.Send(CaTrustingHttpClient.PostMethod, url, new URLSearchParams([...fields]).toString(), undefined);
    }

    private Send(method: string, rawUrl: string, body: string | undefined, bearer: string | undefined): Promise<unknown>
    {
        const C = CaTrustingHttpClient;
        let url: URL;
        try
        {
            url = new URL(rawUrl);
        }
        catch
        {
            return Promise.reject(new Error(C.RequestFailedMessage));
        }
        if (url.protocol !== C.HttpsProtocol)
        {
            return Promise.reject(new Error(C.NonHttpsMessage));
        }
        const headers: Record<string, string | number> = {};
        if (body !== undefined)
        {
            headers[C.ContentTypeHeader] = C.FormContentType;
            headers[C.ContentLengthHeader] = Buffer.byteLength(body);
        }
        if (bearer !== undefined)
        {
            headers[C.AuthorizationHeader] = C.BearerPrefix + bearer;
        }
        return new Promise<unknown>((resolve, reject) =>
        {
            const fail = (): void => reject(new Error(C.RequestFailedMessage));
            const req = https.request({
                agent: this.agent,
                host: url.hostname,
                port: url.port === "" ? C.DefaultPort : Number(url.port),
                path: url.pathname + url.search,
                method,
                headers,
            }, res =>
            {
                const chunks: Buffer[] = [];
                res.on(C.DataEvent, (chunk: Buffer) => chunks.push(chunk));
                res.on(C.EndEvent, () =>
                {
                    const status = res.statusCode ?? 0;
                    if (status < C.OkMin || status >= C.OkMax)
                    {
                        fail();
                        return;
                    }
                    try
                    {
                        resolve(JSON.parse(Buffer.concat(chunks).toString(C.Utf8)));
                    }
                    catch
                    {
                        fail();
                    }
                });
                res.on(C.ErrorEvent, fail);
            });
            req.setTimeout(C.TimeoutMs, () =>
            {
                req.destroy();
                fail();
            });
            req.on(C.ErrorEvent, fail);
            if (body !== undefined)
            {
                req.write(body);
            }
            req.end();
        });
    }
}
