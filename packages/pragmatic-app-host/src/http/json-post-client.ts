import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** The JSON POST could not be completed: unreachable, timed out, an oversized reply or one that is not JSON. Carries
 *  no response text. */
export class JsonPostUnavailableError extends Error
{
    private static readonly ErrorName = 'JsonPostUnavailableError'
    private static readonly MessageText = 'the service is unavailable'

    public constructor()
    {
        super(JsonPostUnavailableError.MessageText)
        this.name = JsonPostUnavailableError.ErrorName
    }
}

/** One reply: its status, its parsed JSON body (undefined when empty) and its response headers. */
export class JsonReply
{
    private static readonly OkStatus = 200

    public constructor(public readonly Status: number, public readonly Body: unknown, public readonly Headers: Readonly<IncomingHttpHeaders> = {})
    {
    }

    public get Ok(): boolean
    {
        return this.Status === JsonReply.OkStatus
    }
}

/**
 * A server-side client for JSON POST APIs (the internal APIs between the platform's servers, and the platform edge):
 * one POST with extra headers and a hard deadline for the whole exchange, the reply under a byte cap. Any status is
 * returned to the caller (a contract's client maps its error codes); only a transport failure throws.
 */
export class JsonPostClient
{
    public static readonly DefaultTimeoutMs = 5000
    public static readonly DefaultMaxReplyBytes = 4 * 1048576
    private static readonly HttpsScheme = 'https:'
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly AcceptHeader = 'accept'
    private static readonly JsonType = 'application/json'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly TimeoutEvent = 'timeout'

    private readonly base: URL

    public constructor(baseUrl: string, private readonly timeoutMs: number = JsonPostClient.DefaultTimeoutMs, private readonly maxReplyBytes: number = JsonPostClient.DefaultMaxReplyBytes)
    {
        this.base = new URL(baseUrl)
    }

    public Post(path: string, body: unknown, headers: Readonly<Record<string, string>> = {}): Promise<JsonReply>
    {
        const C = JsonPostClient
        const url = new URL(path, this.base)
        const payload = Buffer.from(JSON.stringify(body), C.Utf8)
        const send = url.protocol === C.HttpsScheme ? httpsRequest : httpRequest
        return new Promise<JsonReply>((resolve, reject) =>
        {
            let settled = false
            const fail = (): void =>
            {
                if (!settled)
                {
                    settled = true
                    reject(new JsonPostUnavailableError())
                }
            }
            const req = send(url, {
                method: C.MethodPost,
                timeout: this.timeoutMs,
                headers: {
                    ...headers,
                    [C.ContentTypeHeader]: C.JsonType,
                    [C.AcceptHeader]: C.JsonType,
                    [C.ContentLengthHeader]: String(payload.length),
                },
            }, res =>
            {
                const chunks: Buffer[] = []
                let size = 0
                res.on(C.DataEvent, (chunk: Buffer) =>
                {
                    size += chunk.length
                    if (size > this.maxReplyBytes)
                    {
                        fail()
                        req.destroy()
                        return
                    }
                    chunks.push(chunk)
                })
                res.on(C.ErrorEvent, fail)
                res.on(C.EndEvent, () =>
                {
                    if (settled)
                    {
                        return
                    }
                    const text = Buffer.concat(chunks).toString(C.Utf8)
                    let parsed: unknown = undefined
                    if (text.length > 0)
                    {
                        try
                        {
                            parsed = JSON.parse(text) as unknown
                        }
                        catch
                        {
                            fail()
                            return
                        }
                    }
                    settled = true
                    resolve(new JsonReply(res.statusCode ?? 0, parsed, res.headers))
                })
            })
            const deadline = setTimeout(() =>
            {
                fail()
                req.destroy()
            }, this.timeoutMs)
            req.on(C.CloseEvent, () => clearTimeout(deadline))
            req.on(C.TimeoutEvent, () =>
            {
                fail()
                req.destroy()
            })
            req.on(C.ErrorEvent, fail)
            req.end(payload)
        })
    }
}
