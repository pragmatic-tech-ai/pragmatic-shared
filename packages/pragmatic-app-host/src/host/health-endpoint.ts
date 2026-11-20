/** A probe's answer. */
export class HealthResult
{
    public constructor(public readonly Status: number, public readonly Body: string)
    {
    }
}

/** The unauthenticated liveness (/healthz) and readiness (/readyz) probes: answered first, before any Host, Origin,
 *  session or bundle handling (a probe carries no session and may present any Host). */
export class HealthEndpoint
{
    private static readonly LivenessPath = '/healthz'
    private static readonly ReadinessPath = '/readyz'
    private static readonly GetMethod = 'GET'
    private static readonly Ok = new HealthResult(200, 'ok')
    private static readonly NotReady = new HealthResult(503, 'not ready')

    public Handle(method: string, path: string, ready: boolean): HealthResult | null
    {
        if (method.toUpperCase() !== HealthEndpoint.GetMethod)
        {
            return null
        }
        if (path === HealthEndpoint.LivenessPath)
        {
            return HealthEndpoint.Ok
        }
        if (path === HealthEndpoint.ReadinessPath)
        {
            return ready ? HealthEndpoint.Ok : HealthEndpoint.NotReady
        }
        return null
    }
}
