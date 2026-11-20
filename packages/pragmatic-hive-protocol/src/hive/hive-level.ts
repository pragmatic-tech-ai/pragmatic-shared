/**
 * How much the platform reaches into a hive (hive management levels design §4). The wire values are the customer
 * API's `HiveLevel` values. Standalone never enrols, so it never appears on the agent channel.
 */
export enum HiveLevel
{
    Standalone = 'standalone',
    Enrolled = 'enrolled',
    Delegated = 'delegated',
    Hosted = 'hosted',
}

export class HiveLevels
{
    public static readonly All: readonly HiveLevel[] = Object.values(HiveLevel)
    /** The levels a hive enrols at. */
    public static readonly Enrolling: readonly HiveLevel[] = [HiveLevel.Enrolled, HiveLevel.Delegated, HiveLevel.Hosted]
    /** The levels the platform manages by pulled intents (Hosted hives are managed by push). */
    public static readonly Pulling: readonly HiveLevel[] = [HiveLevel.Enrolled, HiveLevel.Delegated]
}
