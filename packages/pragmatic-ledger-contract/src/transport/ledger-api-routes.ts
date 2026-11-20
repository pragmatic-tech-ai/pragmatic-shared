import { HttpMethod, JsonFields, RouteAuth } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { RequestContext, RouteDefinition, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallOutcome } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { LedgerApiLink, LedgerOperation } from '../ledger-api-link.js'
import { LedgerApiError, LedgerErrorCode } from '../errors/ledger-api-error.js'
import { RegisterClientRequest, MyClientReply } from '../dto/client.js'
import { PlanList } from '../dto/plan.js'
import { StartCheckoutRequest } from '../dto/checkout.js'
import { CancelSubscriptionRequest } from '../dto/subscription.js'
import type { ILedgerApiService } from './ledger-api-service.js'

/** One operation's server side: whether it needs a customer, and how its body becomes a reply. */
class LedgerRoute
{
    public constructor(
        public readonly Operation: LedgerOperation,
        public readonly NeedsCustomer: boolean,
        public readonly Handle: (customer: CentralLoginSubject | undefined, body: unknown) => Promise<unknown>)
    {
    }
}

/**
 * The ledger's internal API as AppHost routes: every operation a `POST` (RouteAuth.Public to the host: the caller is
 * the cabinet service, authenticated by the link bearer, acting for the customer whose central-login token it
 * forwards and the ledger verifies). Refusals answer `{ error, code }` with the code's status.
 */
export class LedgerApiRoutes
{
    private static readonly StatusOk = 200
    private static readonly EmptyRequest: readonly string[] = []

    public constructor(private readonly service: ILedgerApiService, private readonly authenticator: CustomerCallAuthenticator)
    {
    }

    public Definitions(): RouteDefinition[]
    {
        return this.Routes().map(route => this.Definition(route))
    }

    public MountOn(table: RouteTable): RouteTable
    {
        for (const definition of this.Definitions())
        {
            table.Add(definition)
        }
        return table
    }

    private Routes(): LedgerRoute[]
    {
        const service = this.service
        return [
            new LedgerRoute(LedgerOperation.RegisterClient, true, async (customer, body) => (await service.RegisterClient(customer as CentralLoginSubject, RegisterClientRequest.Parse(body))).ToJson()),
            new LedgerRoute(LedgerOperation.MyClient, true, async (customer, body) =>
            {
                LedgerApiRoutes.Empty(body)
                return new MyClientReply(await service.MyClient(customer as CentralLoginSubject)).ToJson()
            }),
            new LedgerRoute(LedgerOperation.ListPlans, false, async (_customer, body) =>
            {
                LedgerApiRoutes.Empty(body)
                return new PlanList(await service.ListPlans()).ToJson()
            }),
            new LedgerRoute(LedgerOperation.StartCheckout, true, async (customer, body) => (await service.StartCheckout(customer as CentralLoginSubject, StartCheckoutRequest.Parse(body))).ToJson()),
            new LedgerRoute(LedgerOperation.CancelSubscription, true, async (customer, body) => (await service.CancelSubscription(customer as CentralLoginSubject, CancelSubscriptionRequest.Parse(body))).ToJson()),
        ]
    }

    private Definition(route: LedgerRoute): RouteDefinition
    {
        return {
            Method: HttpMethod.Post,
            Pattern: LedgerApiLink.PathOf(route.Operation),
            Auth: RouteAuth.Public,
            BodyLimit: LedgerApiLink.BodyLimit,
            Handler: async (context: RequestContext) =>
            {
                const call = await this.authenticator.Authenticate(context.Request.headers, route.NeedsCustomer)
                if (call.Outcome === CustomerCallOutcome.Unauthorized)
                {
                    throw new LedgerApiError(LedgerErrorCode.Unauthorized)
                }
                if (call.Outcome === CustomerCallOutcome.NotSignedIn)
                {
                    throw new LedgerApiError(LedgerErrorCode.NotSignedIn)
                }
                const body = (await context.ReadJson()) ?? {}
                context.WriteJson(LedgerApiRoutes.StatusOk, await route.Handle(call.Customer, body))
            },
        }
    }

    private static Empty(body: unknown): void
    {
        JsonFields.Of(body).OnlyKnown(LedgerApiRoutes.EmptyRequest)
    }
}
