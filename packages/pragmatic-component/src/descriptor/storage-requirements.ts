import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';

/** The storage a component needs provisioned for it. */
export class StorageRequirements
{
    public constructor(
        /** A Postgres database of its own. */
        public readonly Postgres: boolean,
    )
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return { [DescriptorKeys.Postgres]: this.Postgres };
    }
}
