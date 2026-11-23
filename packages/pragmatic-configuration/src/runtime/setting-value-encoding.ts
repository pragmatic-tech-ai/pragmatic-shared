import { SettingType } from '@pragmatic-tech-ai/pragmatic-component';

/**
 * How a configured setting value is written into the environment variable its component reads: `string`, `url` and
 * `duration` as they are, `integer` in decimal, `boolean` as `true` or `false`, and `list` as JSON array text
 * (`["a","b,c"]`), so an item holding a comma survives. Every component's list reader accepts the JSON array text
 * (and keeps its comma form for values an operator writes by hand).
 */
export class SettingValueEncoding
{
    private static readonly True = 'true';
    private static readonly False = 'false';
    private static readonly NotEncodable = 'SettingValueEncoding: a value of type';
    private static readonly NotEncodableTail = 'cannot be encoded:';
    private static readonly ArrayOpen = '[';
    private static readonly Comma = ',';

    public static Encode(type: SettingType, value: unknown): string
    {
        const E = SettingValueEncoding;
        switch (type)
        {
            case SettingType.String:
            case SettingType.Url:
            case SettingType.Duration:
                if (typeof value === 'string') return value;
                break;
            case SettingType.Integer:
                if (typeof value === 'number' && Number.isSafeInteger(value)) return value.toString(10);
                break;
            case SettingType.Boolean:
                if (typeof value === 'boolean') return value ? E.True : E.False;
                break;
            case SettingType.List:
                if (Array.isArray(value) && value.every(item => typeof item === 'string')) return JSON.stringify(value);
                break;
            default:
                break;
        }
        throw new Error(`${E.NotEncodable} ${type} ${E.NotEncodableTail} ${typeof value}`);
    }

    /**
     * A list setting as a component reads it from its variable: JSON array text (what `Encode` writes) when the value
     * starts with `[`, else the hand-written comma form (items trimmed, empty items dropped). Undefined for JSON array
     * text that does not parse to strings, so a reader can refuse it.
     */
    public static ReadList(text: string): readonly string[] | undefined
    {
        const E = SettingValueEncoding;
        const trimmed = text.trim();
        if (!trimmed.startsWith(E.ArrayOpen))
        {
            return Object.freeze(trimmed.split(E.Comma).map(item => item.trim()).filter(item => item !== ''));
        }
        try
        {
            const parsed: unknown = JSON.parse(trimmed);
            return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? Object.freeze([...parsed as string[]]) : undefined;
        }
        catch
        {
            return undefined;
        }
    }
}
