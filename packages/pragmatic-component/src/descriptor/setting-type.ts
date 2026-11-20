/** The value type of a setting. A secret setting is a string held in the realm's secrets home (see `SecretReference`). */
export enum SettingType
{
    String = 'string',
    Integer = 'integer',
    Boolean = 'boolean',
    /** An absolute URL (any scheme). */
    Url = 'url',
    /** `<digits><unit>` with unit `ms`, `s`, `m`, `h` or `d`, e.g. `30s`, `8h`. */
    Duration = 'duration',
    /** A list of strings. */
    List = 'list',
}

/** What a value of each `SettingType` looks like in a JSON document. */
export class SettingValues
{
    public static readonly DurationPattern = '^[0-9]+(ms|s|m|h|d)$';

    private static readonly Duration = new RegExp(SettingValues.DurationPattern);
    private static readonly Types: ReadonlySet<string> = new Set(Object.values(SettingType));

    public static IsType(type: string): type is SettingType
    {
        return SettingValues.Types.has(type);
    }

    public static Accepts(type: SettingType, value: unknown): boolean
    {
        switch (type)
        {
            case SettingType.String:
                return typeof value === 'string';
            case SettingType.Integer:
                return typeof value === 'number' && Number.isSafeInteger(value);
            case SettingType.Boolean:
                return typeof value === 'boolean';
            case SettingType.Url:
                return typeof value === 'string' && URL.canParse(value);
            case SettingType.Duration:
                return typeof value === 'string' && SettingValues.Duration.test(value);
            case SettingType.List:
                return Array.isArray(value) && value.every(item => typeof item === 'string');
            default:
                return false;
        }
    }
}
