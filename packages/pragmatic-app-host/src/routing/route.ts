import type { WebSocket } from 'ws'
import type { HttpMethod } from '../http/http-method.js'
import type { RequestContext } from './request-context.js'
import type { SocketContext } from './socket-context.js'

/** Whether a route needs a signed-in session. */
export enum RouteAuth
{
    /** No session needed (sign-in, health of the API, public reads). The Origin guard still applies to mutations. */
    Public = 'public',
    /** A live session; the route's Role and AppRole are then checked against the session's role claims. */
    Session = 'session',
}

/** One declared API route. */
export interface RouteDefinition
{
    Method: HttpMethod
    /** See RoutePattern: literals, `:name` parameters, a trailing `*`. */
    Pattern: string
    Auth: RouteAuth
    /** The tenant role (or any one of the tenant roles) the session must hold; ClaimsAuthorizer.AnySignedIn opens a
     *  mutation to every signed-in subject. A Session mutation that names neither Role nor AppRole is denied. */
    Role?: string | readonly string[]
    /** This application's role (or any one of its roles, by bare name) that admits the session as well; any one role
     *  named in Role or AppRole suffices. */
    AppRole?: string | readonly string[]
    /** Default: audited when it is a mutation that reached its handler with a session. */
    Audited?: boolean
    /** Body limit in bytes (default: the host's DefaultBodyLimit). */
    BodyLimit?: number
    Handler: (context: RequestContext) => Promise<void>
}

/** One declared WebSocket upgrade route. A Session socket authenticates with a single-use ticket in its subprotocol. */
export interface SocketRouteDefinition
{
    Pattern: string
    Auth: RouteAuth
    Role?: string | readonly string[]
    AppRole?: string | readonly string[]
    Handler: (socket: WebSocket, context: SocketContext) => void
}
