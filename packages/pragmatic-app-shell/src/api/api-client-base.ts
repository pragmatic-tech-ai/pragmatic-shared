import { Signal } from '@pragmatic-tech-ai/todl-runtime'
import { AppShellConfig } from '../config/app-shell-config.js'
import { ApiError } from './api-error.js'
import { HttpMethod } from './http-method.js'

/** The fetch the client sends through (the browser's by default; a stub in tests). */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>

/** Whether a request's 401 / 403 is the session's business (most requests) or the caller's own (a sign-in attempt). */
export enum AuthFailureSignal
{
    Raise = 'raise',
    Quiet = 'quiet',
}

/**
 * The JSON API client every application's client derives from, speaking the app-host rules: requests go only to the
 * application's own origin (an absolute path under the configured base path, never a URL) with same-origin
 * credentials, so the browser's Origin header is the host's to check; every mutation carries a JSON body (an empty
 * object when it has nothing to say), because the host refuses other content types. A non-2xx answer throws
 * `ApiError` with the server's `error` text, and every 401 and 403 is first raised on `Unauthorized` / `Forbidden`,
 * so the session reacts to them in one place (expiry back to sign-in) instead of at every call site.
 */
export abstract class ApiClientBase
{
    private static readonly CredentialsMode: RequestCredentials = 'same-origin'
    private static readonly AcceptHeader = 'accept'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly NoContentStatus = 204
    private static readonly RequestFailed = 'Request failed: '
    private static readonly BadRoute = 'ApiClient: a route must be an absolute path on the own origin: '
    private static readonly ErrorField = 'error'
    private static readonly CodeField = 'code'

    /** Raised for every 401 (except a sign-in attempt's own): the session is gone. */
    public readonly Unauthorized = new Signal<ApiError>()
    /** Raised for every 403: the session may not do that. */
    public readonly Forbidden = new Signal<ApiError>()

    private readonly fetcher: FetchFunction

    protected constructor(public readonly Config: AppShellConfig, fetcher?: FetchFunction)
    {
        this.fetcher = fetcher ?? ((url, init) => globalThis.fetch(url, init))
    }

    /** The URL of an own-origin route under the base path; throws for anything that could leave the origin. */
    public Url(route: string): string
    {
        if (!this.IsRoute(route))
        {
            throw new Error(ApiClientBase.BadRoute + route)
        }
        return this.Config.ApiBasePath + route
    }

    protected Get<T>(route: string, signal: AuthFailureSignal = AuthFailureSignal.Raise): Promise<T>
    {
        return this.Send<T>(HttpMethod.Get, route, undefined, signal)
    }

    protected Post<T>(route: string, body?: unknown, signal: AuthFailureSignal = AuthFailureSignal.Raise): Promise<T>
    {
        return this.Send<T>(HttpMethod.Post, route, body, signal)
    }

    protected Put<T>(route: string, body: unknown): Promise<T>
    {
        return this.Send<T>(HttpMethod.Put, route, body, AuthFailureSignal.Raise)
    }

    protected Patch<T>(route: string, body: unknown): Promise<T>
    {
        return this.Send<T>(HttpMethod.Patch, route, body, AuthFailureSignal.Raise)
    }

    protected Delete<T>(route: string, body?: unknown): Promise<T>
    {
        return this.Send<T>(HttpMethod.Delete, route, body, AuthFailureSignal.Raise)
    }

    /** Sends one request and answers its JSON (undefined for 204 or a body that is not JSON). */
    protected async Send<T>(method: HttpMethod, route: string, body: unknown, signal: AuthFailureSignal): Promise<T>
    {
        const url = this.Url(route)
        const response = await this.fetcher(url, this.InitFor(method, body))
        const payload = await ApiClientBase.ReadPayload(response)
        if (response.ok)
        {
            return payload as T
        }
        const error = ApiClientBase.ErrorFor(response.status, payload)
        if (signal === AuthFailureSignal.Raise)
        {
            this.RaiseAuthFailure(error)
        }
        throw error
    }

    private IsRoute(route: string): boolean
    {
        return route.length > 0 && AppShellConfig.IsOwnOriginPath(route)
    }

    private InitFor(method: HttpMethod, body: unknown): RequestInit
    {
        const headers: Record<string, string> = { [ApiClientBase.AcceptHeader]: ApiClientBase.JsonType }
        if (method === HttpMethod.Get)
        {
            return { method, credentials: ApiClientBase.CredentialsMode, headers }
        }
        headers[ApiClientBase.ContentTypeHeader] = ApiClientBase.JsonType
        return { method, credentials: ApiClientBase.CredentialsMode, headers, body: JSON.stringify(body ?? {}) }
    }

    private RaiseAuthFailure(error: ApiError): void
    {
        if (error.IsUnauthorized)
        {
            this.Unauthorized.emit(error)
        }
        else if (error.IsForbidden)
        {
            this.Forbidden.emit(error)
        }
    }

    private static async ReadPayload(response: Response): Promise<unknown>
    {
        if (response.status === ApiClientBase.NoContentStatus)
        {
            return undefined
        }
        try
        {
            return await response.json()
        }
        catch
        {
            return undefined
        }
    }

    private static ErrorFor(status: number, payload: unknown): ApiError
    {
        const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
        const text = body?.[ApiClientBase.ErrorField]
        const code = body?.[ApiClientBase.CodeField]
        return new ApiError(status, typeof text === 'string' && text.length > 0 ? text : ApiClientBase.RequestFailed + String(status),
            typeof code === 'string' ? code : undefined, body)
    }
}
