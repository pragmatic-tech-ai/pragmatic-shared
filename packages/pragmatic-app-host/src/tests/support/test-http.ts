import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One response read to the end. */
export class TestResponse
{
    public constructor(public readonly Status: number, public readonly Headers: IncomingHttpHeaders, public readonly Body: string)
    {
    }

    public Json(): Record<string, unknown>
    {
        return JSON.parse(this.Body) as Record<string, unknown>
    }

    public Header(name: string): string | undefined
    {
        const value = this.Headers[name.toLowerCase()]
        return Array.isArray(value) ? value.join(', ') : value
    }
}

export interface TestRequestOptions
{
    Method?: string
    Headers?: Record<string, string | string[]>
    Body?: string | Buffer
}

/** A throwaway node:http server on a loopback port and a raw client (node:http, so Host and Origin can be set). */
export class TestHttp
{
    private static readonly Loopback = '127.0.0.1'

    private constructor(private readonly server: Server, public readonly Port: number)
    {
    }

    public static async Start(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<TestHttp>
    {
        const server = createServer((req, res) =>
        {
            void Promise.resolve(handler(req, res)).catch(err =>
            {
                if (!res.headersSent)
                {
                    res.writeHead(599)
                }
                res.end(String(err))
            })
        })
        await new Promise<void>(resolve => server.listen(0, TestHttp.Loopback, resolve))
        return new TestHttp(server, (server.address() as AddressInfo).port)
    }

    public static Send(port: number, path: string, options: TestRequestOptions = {}): Promise<TestResponse>
    {
        return new Promise((resolve, reject) =>
        {
            const req = request({ agent: false, host: TestHttp.Loopback, port, path, method: options.Method ?? 'GET', headers: options.Headers ?? {} }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (chunk: Buffer) => chunks.push(chunk))
                res.on('end', () => resolve(new TestResponse(res.statusCode ?? 0, res.headers, Buffer.concat(chunks).toString('utf8'))))
                res.on('error', reject)
            })
            req.on('error', reject)
            if (options.Body !== undefined)
            {
                req.write(options.Body)
            }
            req.end()
        })
    }

    public Send(path: string, options: TestRequestOptions = {}): Promise<TestResponse>
    {
        return TestHttp.Send(this.Port, path, options)
    }

    public async Close(): Promise<void>
    {
        this.server.closeAllConnections()
        await new Promise<void>(resolve => this.server.close(() => resolve()))
    }
}
