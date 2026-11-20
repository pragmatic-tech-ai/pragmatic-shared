import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';
import { SettingType } from './setting-type.js';

/** One setting of an option: its type, whether it is required or secret, its default and its description. */
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
        return json;
    }
}
