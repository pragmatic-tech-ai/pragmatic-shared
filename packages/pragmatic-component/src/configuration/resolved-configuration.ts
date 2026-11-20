import { JsonValue } from '../descriptor/canonical-json.js';
import { ConfigurationKeys } from './configuration-keys.js';
import { SecretReference } from './secret-reference.js';

/** A setting's resolved value: the JSON value of its type, or a `SecretReference` for a secret setting. */
export type SettingValue = string | number | boolean | readonly string[] | SecretReference;

/** One secret setting of an enabled option and the reference it holds. */
export class SecretSetting
{
    public constructor(
        public readonly Option: string,
        public readonly Setting: string,
        public readonly Reference: SecretReference,
    )
    {
        Object.freeze(this);
    }
}

/** A validated configuration: the enabled options (descriptor order) with every given or defaulted setting value. */
export class ResolvedConfiguration
{
    public readonly Options: readonly string[];
    private readonly values: ReadonlyMap<string, ReadonlyMap<string, SettingValue>>;

    /** Built by `ConfigurationValidator`; the maps are taken as they are, in descriptor order. */
    public constructor(values: Map<string, Map<string, SettingValue>>)
    {
        this.values = values;
        this.Options = Object.freeze([...values.keys()]);
        Object.freeze(this);
    }

    public IsEnabled(option: string): boolean
    {
        return this.values.has(option);
    }

    /** The given or default value; undefined for an option not enabled or an optional setting left unset. */
    public Value(option: string, setting: string): SettingValue | undefined
    {
        return this.values.get(option)?.get(setting);
    }

    public SecretReferences(): SecretSetting[]
    {
        const secrets: SecretSetting[] = [];
        for (const [option, settings] of this.values)
        {
            for (const [setting, value] of settings)
            {
                if (value instanceof SecretReference) secrets.push(new SecretSetting(option, setting, value));
            }
        }
        return secrets;
    }

    /** The configuration document with defaults filled in and secret references in their text form. */
    public ToJson(): Record<string, JsonValue>
    {
        const options: Record<string, JsonValue> = {};
        for (const [option, settings] of this.values)
        {
            const members: Record<string, JsonValue> = {};
            for (const [setting, value] of settings)
            {
                members[setting] = value instanceof SecretReference ? value.Format() : value as JsonValue;
            }
            options[option] = members;
        }
        return { [ConfigurationKeys.Options]: options };
    }
}
