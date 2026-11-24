import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request a recorded endpoint received: method, path with query, headers (lower-case names) and body text. */
export class RecordedRequest
{
    public constructor(
        public readonly Method: string,
        public readonly Path: string,
        public readonly Headers: Readonly<Record<string, string>>,
        public readonly Body: string)
    {
        Object.freeze(this)
    }

    /** The body as form fields (`application/x-www-form-urlencoded`). */
    public get Form(): URLSearchParams
    {
        return new URLSearchParams(this.Body)
    }

    /** The body as JSON. */
    public get Json(): unknown
    {
        return JSON.parse(this.Body)
    }
}

/** What a recorded endpoint answers. */
export class RecordedResponse
{
    private static readonly JsonType = 'application/json'

    public constructor(public readonly Status: number, public readonly Body: string, public readonly ContentType: string = RecordedResponse.JsonType)
    {
        Object.freeze(this)
    }

    public static Json(status: number, body: unknown): RecordedResponse
    {
        return new RecordedResponse(status, JSON.stringify(body))
    }
}

/** A route of a recorded endpoint: a method and a path pattern (matched against the path with its query). */
export interface IRecordedRoute
{
    readonly Method: string
    readonly Path: RegExp
    Answer(request: RecordedRequest): RecordedResponse
}

/**
 * A local HTTP server standing in for a cloud's token and secrets endpoints in tests: answers by route and records every
 * request, so a test asserts what was presented (the projected token, the audience) and that an endpoint was never
 * called (a metadata server). Unrouted requests answer 404 and are recorded too.
 */
export class RecordedEndpoints
{
    private static readonly Loopback = '127.0.0.1'
    private static readonly Scheme = 'http://'
    private static readonly PortSeparator = ':'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly NotFound = new RecordedResponse(404, '{"error":"not routed"}')

    public readonly Requests: RecordedRequest[] = []
    private readonly routes: IRecordedRoute[] = []
    private server: Server | undefined

    public Route(method: string, path: RegExp, answer: (request: RecordedRequest) => RecordedResponse): RecordedEndpoints
    {
        this.routes.unshift({ Method: method, Path: path, Answer: answer })
        return this
    }

    public async Start(): Promise<RecordedEndpoints>
    {
        const server = createServer((request, response) => this.Handle(request, response))
        await new Promise<void>(resolve => server.listen(0, RecordedEndpoints.Loopback, () => resolve()))
        this.server = server
        return this
    }

    /** `http://127.0.0.1:<port>` */
    public get Origin(): string
    {
        const address = this.server!.address() as AddressInfo
        return RecordedEndpoints.Scheme + RecordedEndpoints.Loopback + RecordedEndpoints.PortSeparator + address.port
    }

    public To(path: RegExp): RecordedRequest[]
    {
        return this.Requests.filter(request => path.test(request.Path))
    }

    public async Stop(): Promise<void>
    {
        const server = this.server
        this.server = undefined
        if (server === undefined) return
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }

    private Handle(request: IncomingMessage, response: ServerResponse): void
    {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () =>
        {
            const headers: Record<string, string> = {}
            for (const [name, value] of Object.entries(request.headers))
            {
                if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
            }
            const recorded = new RecordedRequest(request.method ?? '', request.url ?? '', headers, Buffer.concat(chunks).toString('utf8'))
            this.Requests.push(recorded)
            const route = this.routes.find(candidate => candidate.Method === recorded.Method && candidate.Path.test(recorded.Path))
            const answer = route === undefined ? RecordedEndpoints.NotFound : route.Answer(recorded)
            response.writeHead(answer.Status, { [RecordedEndpoints.ContentTypeHeader]: answer.ContentType })
            response.end(answer.Body)
        })
    }
}
