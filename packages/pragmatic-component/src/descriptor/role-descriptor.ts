import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';

/** An application role the component declares; the realm maps principals or groups onto it. */
export class RoleDescriptor
{
    public constructor(
        public readonly Name: string,
        public readonly Description: string,
    )
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return { [DescriptorKeys.Name]: this.Name, [DescriptorKeys.Description]: this.Description };
    }
}
