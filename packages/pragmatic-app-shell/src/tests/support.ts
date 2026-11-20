import { DialogService, type DialogOptions } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { IPageNavigator, IPageReloader } from '../browser/browser-page.js'

/** One recorded fetch: the URL and the init the client passed. */
export interface RecordedFetch
{
    Url: string
    Init: RequestInit
}

/** A fetch stand-in: answers each call from a queue of responses (the last one repeats) and records the calls. */
export class FetchStub
{
    public readonly Calls: RecordedFetch[] = []
    private readonly answers: Array<() => Response> = []

    public Json(status: number, body: unknown): FetchStub
    {
        this.answers.push(() => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
        return this
    }

    public Empty(status: number): FetchStub
    {
        this.answers.push(() => new Response(null, { status }))
        return this
    }

    public Text(status: number, text: string): FetchStub
    {
        this.answers.push(() => new Response(text, { status, headers: { 'content-type': 'text/plain' } }))
        return this
    }

    public Failing(error: Error): FetchStub
    {
        this.answers.push(() => { throw error })
        return this
    }

    public get Fetch(): (url: string, init: RequestInit) => Promise<Response>
    {
        return async (url: string, init: RequestInit) =>
        {
            this.Calls.push({ Url: url, Init: init })
            const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]
            if (answer === undefined)
            {
                throw new Error('FetchStub: no answer queued')
            }
            return answer()
        }
    }

    public get Last(): RecordedFetch
    {
        return this.Calls[this.Calls.length - 1]
    }

    public BodyOf(index: number): unknown
    {
        const body = this.Calls[index].Init.body
        return body === undefined || body === null ? undefined : JSON.parse(String(body))
    }

    public HeaderOf(index: number, name: string): string | undefined
    {
        const headers = this.Calls[index].Init.headers as Record<string, string> | undefined
        return headers?.[name]
    }
}

/** Counts reloads and records navigations instead of touching window.location. */
export class FakePage implements IPageReloader, IPageNavigator
{
    public Reloads = 0
    public readonly Assigned: string[] = []

    public Reload(): void
    {
        this.Reloads++
    }

    public Assign(url: string): void
    {
        this.Assigned.push(url)
    }
}

/** A DialogService that never renders: Show records the options and waits for Close or Dismiss. */
export class FakeDialogService extends DialogService
{
    public readonly Shown: DialogOptions[] = []
    private resolve: ((value: unknown) => void) | undefined

    public override Show<T = unknown>(options: DialogOptions): Promise<T | undefined>
    {
        this.Close(undefined)
        this.Shown.push(options)
        return new Promise<T | undefined>(resolve => { this.resolve = resolve as (value: unknown) => void })
    }

    public Dismiss(): void
    {
        this.Close(undefined)
    }

    public override Close(result?: unknown): void
    {
        const resolve = this.resolve
        this.resolve = undefined
        resolve?.(result)
    }

    public override get IsOpen(): boolean
    {
        return this.resolve !== undefined
    }

    public get Last(): unknown
    {
        return this.Shown.length === 0 ? undefined : this.Shown[this.Shown.length - 1].Content
    }
}

/** Lets pending promise continuations run. */
export class Tick
{
    public static Next(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }

    public static async Settle(): Promise<void>
    {
        for (let i = 0; i < 10; i++)
        {
            await Tick.Next()
        }
    }
}

/** A promise settled by hand. */
export class Deferred<T>
{
    public readonly Promise: Promise<T>
    public Resolve!: (value: T) => void
    public Reject!: (reason: unknown) => void

    public constructor()
    {
        this.Promise = new Promise<T>((resolve, reject) =>
        {
            this.Resolve = resolve
            this.Reject = reject
        })
    }
}

/** A fetch stand-in keyed by `METHOD path`: each route answers from its handler (or holds until released). */
export class RoutedFetch
{
    public readonly Calls: RecordedFetch[] = []
    private readonly routes = new Map<string, (body: unknown) => Promise<Response> | Response>()

    public On(method: string, path: string, answer: (body: unknown) => Promise<Response> | Response): RoutedFetch
    {
        this.routes.set(method + ' ' + path, answer)
        return this
    }

    public static Json(status: number, body: unknown): Response
    {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }

    public static Empty(status: number): Response
    {
        return new Response(null, { status })
    }

    public Count(method: string, path: string): number
    {
        return this.Calls.filter(c => c.Init.method === method && c.Url === path).length
    }

    public get Fetch(): (url: string, init: RequestInit) => Promise<Response>
    {
        return async (url: string, init: RequestInit) =>
        {
            this.Calls.push({ Url: url, Init: init })
            const answer = this.routes.get(String(init.method) + ' ' + url)
            if (answer === undefined)
            {
                return RoutedFetch.Json(404, { error: 'Not found' })
            }
            const body = init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body))
            return await answer(body)
        }
    }
}
