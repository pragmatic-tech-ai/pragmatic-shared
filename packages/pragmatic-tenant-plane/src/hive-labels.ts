/** The label every object of a hive carries, and its value: the one home of the name, imported by whoever renders objects. */
export class HiveLabels
{
    public static readonly Label = 'pragmatic/hive'

    private constructor()
    {
    }

    /** The labels that mark an object as the hive's. */
    public static Of(hiveId: string): Record<string, string>
    {
        return { [HiveLabels.Label]: hiveId }
    }
}
