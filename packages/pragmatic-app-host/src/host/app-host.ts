import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { AppHostConfig } from './app-host-config.js'
import { HealthEndpoint } from './health-endpoint.js'
import type { RouteTable, Route, SocketRoute } from '../routing/route-table.js'
import { RouteAuth } from '../routing/route.js'
import { RequestContext } from '../routing/request-context.js'
import { SocketContext } from '../routing/socket-context.js'
import { OriginGuard } from '../guards/origin-guard.js'
import { ClientAddress } from '../guards/client-address.js'
import { JsonApi } from '../http/json-api.js'
import { HttpMethod, HttpMethods } from '../http/http-method.js'
import { ProblemMapper } from '../http/problem-mapper.js'
import { BodyTooLargeError } from '../http/body-too-large-error.js'
import { AuthorizationOutcome, ClaimsAuthorizer } from '../authz/claims-authorizer.js'
import { AuditEntry } from '../audit/audit-entry.js'
import type { AuditTrail } from '../audit/audit-trail.js'
import type { SessionGate } from '../session/session-gate.js'
import type { SessionRecord } from '../session/session-record.js'
import type { WsTicketStore } from '../session/ws-ticket-store.js'
import type { MuralBundle } from '../bundle/mural-bundle.js'
import { RateLimiter } from '../limits/rate-limiter.js'
import { InMemoryThrottleRepository } from '../limits/throttle-repository.js'

/** The collaborators of an AppHost. Only Routes is required. */
export interface AppHostModules
{
    Routes: RouteTable
    /** Authentication: needed by Session routes (without it every Session route answers 401). */
    Sessions?: SessionGate
    /** Default: a ClaimsAuthorizer on the `roles` claim. */
    Authorizer?: ClaimsAuthorizer
    /** Without it nothing is audited. */
    Audit?: AuditTrail
    /** The UI; without it non-API paths are 404. */
    Bundle?: MuralBundle
    /** Default: a mapper with no domain table that logs to console.error. */
    Problems?: ProblemMapper
    /** Limits refused unauthenticated mutations per client address (they are audited as anonymous). Default: in memory,
     *  30 per minute, one minute lockout. */
    DenialLimiter?: RateLimiter
    /** Optional: limits every API request per client address. */
    ApiLimiter?: RateLimiter
    /** Authenticates Session socket upgrades (a single-use ticket in the subprotocol). */
    Tickets?: WsTicketStore
}

/**
 * The server of a Mural application: node:http plus WebSocket upgrades, one ordered pipeline for every request:
 * health -> allowed Host -> body type -> Origin (mutations) -> authentication -> authorization -> route -> UI bundle.
 * Security headers go on every response. A refused mutation is audited (as anonymous before authentication, under the
 * denial rate limit); an authorized mutation is audited once, after its response, with its final status; Close awaits
 * the writes still running.
 */
export class AppHost
{
    private static readonly BaseUrl = 'http://localhost'
    private static readonly RootPath = '/'
    private static readonly ErrorField = 'error'
    private static readonly ForbiddenHostMessage = 'Forbidden host'
    private static readonly UnsupportedMediaMessage = 'Content-Type must be application/json'
    private static readonly BadOriginMessage = 'Cross-origin request refused'
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly ForbiddenMessage = 'Forbidden'
    private static readonly NotFoundMessage = 'Not found'
    private static readonly MethodNotAllowedMessage = 'Method not allowed'
    private static readonly TooManyRequestsMessage = 'Too many requests'
    private static readonly NotListeningMessage = 'AppHost is not listening'
    private static readonly TextPlainType = 'text/plain; charset=utf-8'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly AllowHeader = 'Allow'
    private static readonly AllowSeparator = ', '
    private static readonly ProtocolHeader = 'sec-websocket-protocol'
    private static readonly ProtocolSeparator = ','
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly StatusNoContent = 204
    private static readonly StatusUnauthorized = 401
    private static readonly StatusForbidden = 403
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusTooLarge = 413
    private static readonly StatusUnsupported = 415
    private static readonly StatusTooManyRequests = 429
    private static readonly DenialMaxHits = 30
    private static readonly DenialWindowMs = 60_000
    private static readonly DenialLockoutMs = 60_000
    private static readonly DenialLimiterName = 'denials'
    private static readonly LogPrefix = '[app-host]'

    private readonly health = new HealthEndpoint()
    private readonly origins: OriginGuard
    private readonly addresses: ClientAddress
    private readonly authorizer: ClaimsAuthorizer
    private readonly problems: ProblemMapper
    private readonly denials: RateLimiter
    private readonly sockets = new Set<WebSocket>()
    private readonly wss: WebSocketServer
    private server: Server | undefined
    private ready = true

    public constructor(private readonly config: AppHostConfig, private readonly modules: AppHostModules)
    {
        this.origins = new OriginGuard(config.TrustedProxy)
        this.addresses = new ClientAddress(config.TrustedProxy)
        this.authorizer = modules.Authorizer ?? new ClaimsAuthorizer()
        this.problems = modules.Problems ?? new ProblemMapper(err => console.error(AppHost.LogPrefix, err))
        this.denials = modules.DenialLimiter ?? new RateLimiter(new InMemoryThrottleRepository(), { Name: AppHost.DenialLimiterName, MaxHits: AppHost.DenialMaxHits, WindowMs: AppHost.DenialWindowMs, LockoutMs: AppHost.DenialLockoutMs })
        this.wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => AppHost.FirstProtocol(protocols) })
    }

    /** Readiness for /readyz (liveness is always ok while the process serves). */
    public SetReady(ready: boolean): void
    {
        this.ready = ready
    }

    public async Listen(port: number, host?: string): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Handle(req, res)
        })
        server.on(AppHost.UpgradeEvent, (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        {
            void this.Upgrade(req, socket, head)
        })
        await new Promise<void>((resolve, reject) =>
        {
            server.once(AppHost.ErrorEvent, reject)
            server.listen(port, host, () =>
            {
                server.off(AppHost.ErrorEvent, reject)
                resolve()
            })
        })
        this.server = server
    }

    public Address(): { address: string, port: number }
    {
        const address = this.server?.address() as AddressInfo | null | undefined
        if (address === null || address === undefined)
        {
            throw new Error(AppHost.NotListeningMessage)
        }
        return { address: address.address, port: address.port }
    }

    /** Stops accepting, closes every socket and connection, and resolves once no audit write is still running. */
    public async Close(): Promise<void>
    {
        for (const socket of this.sockets)
        {
            socket.terminate()
        }
        this.sockets.clear()
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            const closed = new Promise<void>(resolve => server.close(() => resolve()))
            server.closeAllConnections()
            await closed
        }
        this.wss.close()
        await this.modules.Audit?.Drain()
    }

    private async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        // Set only once an authorized mutation reaches its handler; the single emit site is the finally below, so a
        // handler that returns OR throws is audited exactly once, on its final status.
        let audited: { Actor: string, Method: string, Path: string, Context: RequestContext } | undefined
        try
        {
            this.config.Security.Apply(res)
            const method = (req.method ?? HttpMethod.Get).toUpperCase()
            const url = new URL(req.url ?? AppHost.RootPath, AppHost.BaseUrl)
            const path = url.pathname
            const probe = this.health.Handle(method, path, this.ready)
            if (probe !== null)
            {
                JsonApi.Drain(req)
                res.writeHead(probe.Status, { [AppHost.ContentTypeHeader]: AppHost.TextPlainType })
                res.end(probe.Body)
                return
            }
            if (!this.config.AllowedHosts.Allows(req))
            {
                this.Refuse(req, res, AppHost.StatusForbidden, AppHost.ForbiddenHostMessage)
                return
            }
            if (JsonApi.HasBody(req) && !JsonApi.IsJson(req))
            {
                this.Refuse(req, res, AppHost.StatusUnsupported, AppHost.UnsupportedMediaMessage)
                return
            }
            const address = this.addresses.Of(req)
            const mutating = HttpMethods.IsMutating(method)
            const match = this.modules.Routes.Match(method, path)
            const isApi = path.startsWith(this.config.ApiPrefix) || match.Route !== undefined || match.AllowedMethods.length > 0
            if (isApi && this.modules.ApiLimiter !== undefined)
            {
                const decision = await this.modules.ApiLimiter.Hit(address)
                if (!decision.Allowed)
                {
                    this.WriteTooMany(req, res, decision.RetryAfterSeconds())
                    return
                }
            }
            if (mutating && !this.origins.Allows(req))
            {
                await this.RefuseAnonymous(req, res, address, method, path, AppHost.StatusForbidden, AppHost.BadOriginMessage)
                return
            }
            const route = match.Route
            if (route === undefined)
            {
                this.Unrouted(req, res, path, isApi, match.AllowedMethods)
                return
            }
            const session = this.modules.Sessions === undefined ? null : await this.modules.Sessions.Current(req)
            const outcome = this.authorizer.Authorize(route.Definition, session)
            if (outcome === AuthorizationOutcome.Unauthenticated)
            {
                if (mutating)
                {
                    await this.RefuseAnonymous(req, res, address, method, path, AppHost.StatusUnauthorized, AppHost.UnauthenticatedMessage)
                    return
                }
                this.Refuse(req, res, AppHost.StatusUnauthorized, AppHost.UnauthenticatedMessage)
                return
            }
            if (outcome === AuthorizationOutcome.Forbidden)
            {
                this.Refuse(req, res, AppHost.StatusForbidden, AppHost.ForbiddenMessage)
                if (mutating)
                {
                    await this.Record(this.ActorOf(session), method, path, AppHost.StatusForbidden, undefined)
                }
                return
            }
            const bodyLimit = route.Definition.BodyLimit ?? this.config.DefaultBodyLimit
            const declared = JsonApi.DeclaredLength(req)
            if (declared !== undefined && declared > bodyLimit)
            {
                this.Refuse(req, res, AppHost.StatusTooLarge, BodyTooLargeError.DefaultMessage)
                return
            }
            const context = new RequestContext(req, res, path, match.Params, url.searchParams, session, address, bodyLimit)
            if (this.IsAudited(route, session))
            {
                audited = { Actor: this.ActorOf(session), Method: method, Path: path, Context: context }
            }
            await route.Definition.Handler(context)
            if (!res.headersSent)
            {
                res.writeHead(AppHost.StatusNoContent)
                res.end()
            }
        }
        catch (err)
        {
            if (!req.readableEnded)
            {
                JsonApi.Drain(req)
            }
            this.problems.Write(res, err)
        }
        finally
        {
            if (audited !== undefined)
            {
                await this.Record(audited.Actor, audited.Method, audited.Path, res.statusCode, audited.Context.AuditNote)
            }
        }
    }

    /** A matched route is audited when it says so (mutations by default) and there is someone to name; a public route
     *  without a session is audited only when it asks explicitly. */
    private IsAudited(route: Route, session: SessionRecord | null): boolean
    {
        return route.Audited && (session !== null || route.Definition.Audited === true)
    }

    private Unrouted(req: IncomingMessage, res: ServerResponse, path: string, isApi: boolean, allowed: readonly HttpMethod[]): void
    {
        if (allowed.length > 0)
        {
            JsonApi.Drain(req)
            res.setHeader(AppHost.AllowHeader, allowed.join(AppHost.AllowSeparator))
            JsonApi.WriteJson(res, AppHost.StatusMethodNotAllowed, { [AppHost.ErrorField]: AppHost.MethodNotAllowedMessage })
            return
        }
        if (isApi || this.modules.Bundle === undefined)
        {
            this.Refuse(req, res, AppHost.StatusNotFound, AppHost.NotFoundMessage)
            return
        }
        JsonApi.Drain(req)
        this.modules.Bundle.Serve(req, res, path)
    }

    /** A refusal before authentication of a mutation: rate-limited per client address, then audited as anonymous. The
     *  hit is counted before the awaited audit write, so a parallel burst cannot slip past the gate. */
    private async RefuseAnonymous(req: IncomingMessage, res: ServerResponse, address: string, method: string, path: string, status: number, message: string): Promise<void>
    {
        const decision = await this.denials.Hit(address)
        if (!decision.Allowed)
        {
            this.WriteTooMany(req, res, decision.RetryAfterSeconds())
            return
        }
        this.Refuse(req, res, status, message)
        await this.Record(AuditEntry.AnonymousActor, method, path, status, undefined)
    }

    private Refuse(req: IncomingMessage, res: ServerResponse, status: number, message: string): void
    {
        JsonApi.Drain(req)
        JsonApi.WriteJson(res, status, { [AppHost.ErrorField]: message })
    }

    private WriteTooMany(req: IncomingMessage, res: ServerResponse, retryAfterSeconds: number): void
    {
        res.setHeader(AppHost.RetryAfterHeader, String(retryAfterSeconds))
        this.Refuse(req, res, AppHost.StatusTooManyRequests, AppHost.TooManyRequestsMessage)
    }

    private async Record(actor: string, method: string, path: string, status: number, note: string | undefined): Promise<void>
    {
        await this.modules.Audit?.Record(actor, method, path, status, note)
    }

    private ActorOf(session: SessionRecord | null): string
    {
        return session === null ? AuditEntry.AnonymousActor : session.Claims.First(this.config.AuditActorClaim) ?? session.Subject
    }

    /** A WebSocket upgrade: a declared socket route, an allowed Host and Origin, and for a Session socket a single-use
     *  ticket (the lone subprotocol) naming a live session that the route's role admits; anything else destroys it. */
    private async Upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
    {
        try
        {
            const path = new URL(req.url ?? AppHost.RootPath, AppHost.BaseUrl).pathname
            const match = this.modules.Routes.MatchSocket(path)
            if (match === undefined || !this.config.AllowedHosts.Allows(req) || !this.origins.Allows(req))
            {
                socket.destroy()
                return
            }
            const session = await this.SocketSession(match.Route, req)
            if (session === undefined)
            {
                socket.destroy()
                return
            }
            const context = new SocketContext(req, match.Params, session, this.addresses.Of(req))
            this.wss.handleUpgrade(req, socket, head, ws =>
            {
                this.sockets.add(ws)
                ws.on(AppHost.CloseEvent, () => this.sockets.delete(ws))
                match.Route.Definition.Handler(ws, context)
            })
        }
        catch
        {
            socket.destroy()
        }
    }

    /** The session a socket upgrade runs under (null for a public socket), or undefined when it is refused. */
    private async SocketSession(route: SocketRoute, req: IncomingMessage): Promise<SessionRecord | null | undefined>
    {
        if (route.Definition.Auth === RouteAuth.Public)
        {
            return null
        }
        const ticket = AppHost.SingleProtocol(req)
        const tickets = this.modules.Tickets
        const gate = this.modules.Sessions
        if (ticket === undefined || tickets === undefined || gate === undefined)
        {
            return undefined
        }
        const sessionId = await tickets.Redeem(ticket)
        const session = sessionId === null ? null : await gate.Sessions.ValidateId(sessionId)
        if (session === null)
        {
            return undefined
        }
        const outcome = this.authorizer.Authorize({ Method: HttpMethod.Get, Auth: route.Definition.Auth, Role: route.Definition.Role }, session)
        return outcome === AuthorizationOutcome.Allowed ? session : undefined
    }

    /** The lone Sec-WebSocket-Protocol value (the ticket), or undefined when absent, empty or multi-valued. */
    private static SingleProtocol(req: IncomingMessage): string | undefined
    {
        const raw = req.headers[AppHost.ProtocolHeader]
        if (typeof raw !== 'string')
        {
            return undefined
        }
        const value = raw.trim()
        return value.length === 0 || value.includes(AppHost.ProtocolSeparator) ? undefined : value
    }

    private static FirstProtocol(protocols: Set<string>): string | false
    {
        const first = protocols.values().next()
        return first.done === true ? false : first.value
    }
}
