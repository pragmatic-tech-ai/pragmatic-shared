/** The internal API's routes (admin listens, the edge calls). Version-prefixed so both sides can evolve together. */
export class InternalApiRoutes
{
    /** POST: body = AgentChannelRequest, reply = AgentChannelReply. */
    public static readonly Agent = '/internal/v1/agent'
    /** POST: body = { email }, reply = DiscoveryReply. */
    public static readonly Discover = '/internal/v1/desktop/discover'
    /** POST: body = a hive-protocol envelope's wire text, relayed verbatim by the edge from `/agent/v2/exchange`; reply
     *  200 with an envelope, 204, or a refusal `{ error, code }` (C3.3). */
    public static readonly AgentExchange = '/internal/v2/agent/exchange'
    /** GET, no auth: liveness. */
    public static readonly Healthz = '/internal/v1/healthz'
}
