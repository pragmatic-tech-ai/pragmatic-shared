import { HttpMethod, HttpProblem, InternalApiGuard, RouteAuth } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { InternalApiCredential, RequestContext, RouteDefinition, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementStatement } from '../statement/entitlement-statement.js'
import { EntitlementReceipt, ReceiptOutcome } from './entitlement-receipt.js'
import type { IEntitlementSink } from './entitlement-sink.js'
import { EntitlementsLink } from './entitlements-link.js'

/**
 * The platform admin console's side: authenticates the ledger's bearer, decodes the statement strictly, and hands it
 * to the sink only when its version is newer than the one held (equal: duplicate, older: stale; both answered 200 so
 * the ledger stops resending). Statements of one client are handled one at a time.
 */
export class EntitlementReceiver
{
    private static readonly StatusOk = 200
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly StatusUnauthorized = 401
    private static readonly UnauthorizedMessage = 'Unauthorized'

    private readonly queues = new Map<string, Promise<unknown>>()

    public constructor(private readonly credential: InternalApiCredential, private readonly sink: IEntitlementSink)
    {
    }

    /** Transport-free: `authorization` is the request's header, `body` its parsed JSON. Throws an HttpProblem (401
     *  `unauthorized`, 400 `invalid-request`) for a refusal. */
    public async Receive(authorization: string | undefined, body: unknown): Promise<EntitlementReceipt>
    {
        this.RequireLink(authorization)
        const statement = EntitlementStatement.Parse(body)
        return this.Serialised(statement.ClientId, () => this.Accept(statement))
    }

    /** The route to declare on the platform admin console's mesh-facing AppHost. */
    public Route(): RouteDefinition
    {
        return {
            Method: HttpMethod.Post,
            Pattern: EntitlementsLink.StatementsPath,
            Auth: RouteAuth.Public,
            BodyLimit: EntitlementsLink.BodyLimit,
            Handler: async (context: RequestContext) =>
            {
                const header = context.Request.headers[EntitlementReceiver.AuthorizationHeader]
                const authorization = typeof header === 'string' ? header : undefined
                this.RequireLink(authorization)
                const receipt = await this.Receive(authorization, await context.ReadJson())
                context.WriteJson(EntitlementReceiver.StatusOk, receipt.ToJson())
            },
        }
    }

    public MountOn(table: RouteTable): RouteTable
    {
        return table.Add(this.Route())
    }

    /** The body is read only once the link bearer is right. */
    private RequireLink(authorization: string | undefined): void
    {
        if (!this.credential.MatchesAuthorization(authorization))
        {
            throw new HttpProblem(EntitlementReceiver.StatusUnauthorized, EntitlementReceiver.UnauthorizedMessage, InternalApiGuard.UnauthorizedCode)
        }
    }

    private async Accept(statement: EntitlementStatement): Promise<EntitlementReceipt>
    {
        const current = await this.sink.CurrentVersion(statement.ClientId)
        if (current !== undefined && statement.Version <= current)
        {
            return new EntitlementReceipt(statement.Version === current ? ReceiptOutcome.Duplicate : ReceiptOutcome.Stale, current)
        }
        await this.sink.Apply(statement)
        return new EntitlementReceipt(ReceiptOutcome.Applied, statement.Version)
    }

    private Serialised<T>(clientId: string, work: () => Promise<T>): Promise<T>
    {
        const previous = this.queues.get(clientId) ?? Promise.resolve()
        const next = previous.then(work, work)
        const tail = next.catch(() => undefined)
        this.queues.set(clientId, tail)
        void tail.then(() =>
        {
            if (this.queues.get(clientId) === tail)
            {
                this.queues.delete(clientId)
            }
        })
        return next
    }
}
