/**
 * How long a stopping component has (C3.1 Ledger, env-server row): the termination grace period the hive manifests render
 * for a component that drains its connections before it exits, and the longest drain it may be configured with, both from
 * here, so the builder's grace period and the component's declared drain limit cannot drift apart. The drain leaves
 * AfterDrainSeconds of the grace period for what follows it (the access audit flush, the database close) before the
 * kubelet kills the pod.
 */
export class ComponentTermination
{
    /** The pod's termination grace period: Kubernetes' default, rendered explicitly so the drain limit below holds. */
    public static readonly GracePeriodSeconds = 30;
    /** What the grace period keeps after the longest drain. */
    public static readonly AfterDrainSeconds = 5;
    private static readonly MillisecondsPerSecond = 1000;
    /** The longest configurable drain, in milliseconds (25 s). */
    public static readonly LongestDrainMs = (ComponentTermination.GracePeriodSeconds - ComponentTermination.AfterDrainSeconds) * ComponentTermination.MillisecondsPerSecond;

    private constructor()
    {
    }
}
