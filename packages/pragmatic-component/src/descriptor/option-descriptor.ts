import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';
import { SettingDescriptor } from './setting-descriptor.js';

/** An option a component supports (e.g. an identity source), with the settings a configuration gives it. */
export class OptionDescriptor
{
    public readonly Settings: readonly SettingDescriptor[];

    public constructor(
        public readonly Name: string,
        public readonly Description: string,
        settings: readonly SettingDescriptor[],
    )
    {
        this.Settings = Object.freeze([...settings]);
        Object.freeze(this);
    }

    public Setting(name: string): SettingDescriptor | undefined
    {
        return this.Settings.find(setting => setting.Name === name);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return {
            [DescriptorKeys.Name]: this.Name,
            [DescriptorKeys.Description]: this.Description,
            [DescriptorKeys.Settings]: this.Settings.map(setting => setting.ToJson()),
        };
    }
}
