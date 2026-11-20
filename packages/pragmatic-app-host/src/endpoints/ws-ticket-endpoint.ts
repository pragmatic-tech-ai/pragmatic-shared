import type { WsTicketStore } from '../session/ws-ticket-store.js'
import type { RouteTable } from '../routing/route-table.js'
import { RouteAuth } from '../routing/route.js'
import type { RequestContext } from '../routing/request-context.js'
import { HttpMethod } from '../http/http-method.js'
import { ClaimsAuthorizer } from '../authz/claims-authorizer.js'
import { CacheControl } from '../http/cache-control.js'

/** POST mints a single-use WebSocket ticket for the caller's session (any signed-in subject; not audited). The browser
 *  then opens the socket with the ticket as its only subprotocol. */
export class WsTicketEndpoint
{
    private static readonly DefaultPath = '/api/ws-ticket'
    private static readonly StatusOk = 200
    private static readonly TicketField = 'ticket'

    public constructor(private readonly tickets: WsTicketStore)
    {
    }

    public Register(table: RouteTable, path: string = WsTicketEndpoint.DefaultPath): void
    {
        table.Add({ Method: HttpMethod.Post, Pattern: path, Auth: RouteAuth.Session, Role: ClaimsAuthorizer.AnySignedIn, Audited: false, Handler: ctx => this.Mint(ctx) })
    }

    private async Mint(ctx: RequestContext): Promise<void>
    {
        const ticket = await this.tickets.Mint(ctx.RequireSession().Id)
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(WsTicketEndpoint.StatusOk, { [WsTicketEndpoint.TicketField]: ticket })
    }
}
