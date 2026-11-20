import type { HttpMethod } from '../http/http-method.js'
import { HttpMethods } from '../http/http-method.js'
import type { RouteDefinition, SocketRouteDefinition } from './route.js'
import { RoutePattern } from './route-pattern.js'

/** A declared route with its compiled pattern. */
export class Route
{
    public readonly Pattern: RoutePattern

    public constructor(public readonly Definition: RouteDefinition)
    {
        this.Pattern = new RoutePattern(Definition.Pattern)
    }

    public get Method(): HttpMethod
    {
        return this.Definition.Method
    }

    public get Auth(): RouteDefinition['Auth']
    {
        return this.Definition.Auth
    }

    /** Audited unless it says otherwise when it is a mutation. */
    public get Audited(): boolean
    {
        return this.Definition.Audited ?? HttpMethods.IsMutating(this.Definition.Method)
    }
}

/** A declared socket route with its compiled pattern. */
export class SocketRoute
{
    public readonly Pattern: RoutePattern

    public constructor(public readonly Definition: SocketRouteDefinition)
    {
        this.Pattern = new RoutePattern(Definition.Pattern)
    }
}

/** What a lookup found: the route and its params, or (when the path is known under other methods) those methods. */
export class RouteMatch
{
    public constructor(public readonly Route: Route | undefined, public readonly Params: ReadonlyMap<string, string>, public readonly AllowedMethods: readonly HttpMethod[])
    {
    }
}

/** The application's declared routes. Lookup prefers the most literal pattern, then declaration order. */
export class RouteTable
{
    private static readonly DuplicateMessage = 'Route declared twice: '
    private static readonly BodyLimitMessage = 'A route body limit must be a positive integer: '
    private static readonly KeySeparator = ' '
    private static readonly NoParams: ReadonlyMap<string, string> = new Map()

    private readonly routes: Route[] = []
    private readonly sockets: SocketRoute[] = []
    private readonly keys = new Set<string>()

    public Add(definition: RouteDefinition): this
    {
        const key = definition.Method + RouteTable.KeySeparator + definition.Pattern
        if (this.keys.has(key))
        {
            throw new Error(RouteTable.DuplicateMessage + key)
        }
        if (definition.BodyLimit !== undefined && (!Number.isInteger(definition.BodyLimit) || definition.BodyLimit <= 0))
        {
            throw new Error(RouteTable.BodyLimitMessage + key)
        }
        this.routes.push(new Route(definition))
        this.keys.add(key)
        return this
    }

    public AddSocket(definition: SocketRouteDefinition): this
    {
        if (this.sockets.some(socket => socket.Definition.Pattern === definition.Pattern))
        {
            throw new Error(RouteTable.DuplicateMessage + definition.Pattern)
        }
        this.sockets.push(new SocketRoute(definition))
        return this
    }

    public Match(method: string, path: string): RouteMatch
    {
        let best: { Route: Route, Params: ReadonlyMap<string, string> } | undefined
        const allowed: HttpMethod[] = []
        for (const route of this.routes)
        {
            const params = route.Pattern.Match(path)
            if (params === null)
            {
                continue
            }
            if (route.Method !== method.toUpperCase())
            {
                allowed.push(route.Method)
                continue
            }
            if (best === undefined || route.Pattern.Specificity > best.Route.Pattern.Specificity)
            {
                best = { Route: route, Params: params }
            }
        }
        return best === undefined ? new RouteMatch(undefined, RouteTable.NoParams, [...new Set(allowed)]) : new RouteMatch(best.Route, best.Params, [])
    }

    public MatchSocket(path: string): { Route: SocketRoute, Params: ReadonlyMap<string, string> } | undefined
    {
        for (const route of this.sockets)
        {
            const params = route.Pattern.Match(path)
            if (params !== null)
            {
                return { Route: route, Params: params }
            }
        }
        return undefined
    }
}
