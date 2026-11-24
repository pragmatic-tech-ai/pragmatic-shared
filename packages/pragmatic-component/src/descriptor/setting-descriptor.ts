import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';
import { SettingType } from './setting-type.js';

/** One setting of an option: its type, whether it is required or secret, its default, its description and, for an integer,
 *  the smallest and largest value it accepts (inclusive; each optional). */
export class SettingDescriptor
{
    /** Built by `ComponentDescriptorBuilder`, which enforces the rules; `Default` is frozen. */
    public constructor(
        public readonly Name: string,
        public readonly Type: SettingType,
        public readonly Required: boolean,
        public readonly Secret: boolean,
        public readonly Default: JsonValue | undefined,
        public readonly Description: string,
        public readonly Minimum: number | undefined = undefined,
        public readonly Maximum: number | undefined = undefined,
    )
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        const json: Record<string, JsonValue> = {
            [DescriptorKeys.Name]: this.Name,
            [DescriptorKeys.Type]: this.Type,
            [DescriptorKeys.Required]: this.Required,
            [DescriptorKeys.Secret]: this.Secret,
        };
        if (this.Default !== undefined) json[DescriptorKeys.Default] = this.Default;
        json[DescriptorKeys.Description] = this.Description;
        if (this.Minimum !== undefined) json[DescriptorKeys.Minimum] = this.Minimum;
        if (this.Maximum !== undefined) json[DescriptorKeys.Maximum] = this.Maximum;
        return json;
    }
}
