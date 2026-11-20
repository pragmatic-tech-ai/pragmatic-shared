import type { IncomingMessage, ServerResponse } from 'node:http'
import { BodyTooLargeError } from './body-too-large-error.js'
import { BadRequestProblem } from './http-problem.js'
import { HttpMethod } from './http-method.js'

/** JSON request and response primitives: bodies read under a byte limit (an oversized one is drained to its end
 *  before BodyTooLargeError, because closing with unread bytes makes TCP reset the connection and the caller would see
 *  ECONNRESET instead of the 413), JSON answers, and the body-type checks of the pipeline. */
export class JsonApi
{
    public static readonly ContentTypeHeader = 'Content-Type'
    public static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly JsonMediaType = 'application/json'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly TransferEncodingHeader = 'transfer-encoding'
    private static readonly RequestContentTypeHeader = 'content-type'
    private static readonly ParameterSeparator = ';'
    private static readonly EmptyLength = '0'
    private static readonly DigitsPattern = /^\d+$/
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly BodyMethods: ReadonlySet<string> = new Set([HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete])

    /** The parsed JSON body (undefined when empty). Over `maxBytes`: drains, then rejects with BodyTooLargeError;
     *  malformed: rejects with BadRequestProblem. */
    public static async ReadJson(req: IncomingMessage, maxBytes: number): Promise<unknown>
    {
        const raw = await JsonApi.ReadText(req, maxBytes)
        if (raw.length === 0)
        {
            return undefined
        }
        try
        {
            return JSON.parse(raw) as unknown
        }
        catch
        {
            throw new BadRequestProblem(BadRequestProblem.InvalidJsonMessage)
        }
    }

    /** ReadJson that also requires a JSON object (not an array, null or a scalar). */
    public static async ReadJsonObject(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>>
    {
        const body = await JsonApi.ReadJson(req, maxBytes)
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            throw new BadRequestProblem(BadRequestProblem.ObjectRequiredMessage)
        }
        return body as Record<string, unknown>
    }

    /** The body as text, collected up to `maxBytes`; past it the rest is read and discarded, then the read rejects. */
    public static ReadText(req: IncomingMessage, maxBytes: number): Promise<string>
    {
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(JsonApi.DataEvent, (chunk: Buffer) =>
            {
                if (tooLarge)
                {
                    return
                }
                size += chunk.length
                if (size > maxBytes)
                {
                    tooLarge = true
                    chunks.length = 0
                    return
                }
                chunks.push(chunk)
            })
            req.on(JsonApi.EndEvent, () =>
            {
                if (tooLarge)
                {
                    reject(new BodyTooLargeError())
                    return
                }
                resolve(Buffer.concat(chunks).toString(JsonApi.Utf8))
            })
            req.on(JsonApi.ErrorEvent, reject)
        })
    }

    public static WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [JsonApi.ContentTypeHeader]: JsonApi.JsonType })
        res.end(JSON.stringify(body))
    }

    /** Discards whatever body the request still carries (so a refusal reaches the caller instead of a reset). */
    public static Drain(req: IncomingMessage): void
    {
        req.resume()
    }

    /** Whether a body-carrying method actually carries one (a non-zero Content-Length or a transfer encoding). */
    public static HasBody(req: IncomingMessage): boolean
    {
        if (!JsonApi.BodyMethods.has((req.method ?? '').toUpperCase()))
        {
            return false
        }
        const length = req.headers[JsonApi.ContentLengthHeader]
        return (length !== undefined && length !== JsonApi.EmptyLength) || req.headers[JsonApi.TransferEncodingHeader] !== undefined
    }

    public static IsJson(req: IncomingMessage): boolean
    {
        const type = req.headers[JsonApi.RequestContentTypeHeader] ?? ''
        return (type.split(JsonApi.ParameterSeparator)[0] ?? '').trim().toLowerCase() === JsonApi.JsonMediaType
    }

    /** The declared Content-Length, or undefined when absent or not a non-negative integer. */
    public static DeclaredLength(req: IncomingMessage): number | undefined
    {
        const raw = req.headers[JsonApi.ContentLengthHeader]
        if (raw === undefined || !JsonApi.DigitsPattern.test(raw))
        {
            return undefined
        }
        return Number(raw)
    }
}
