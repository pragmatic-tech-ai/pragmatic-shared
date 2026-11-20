import { CanonicalJson, JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';
import { EndpointDescriptor } from './endpoint-descriptor.js';
import { OptionDescriptor } from './option-descriptor.js';
import { RoleDescriptor } from './role-descriptor.js';
import { StorageRequirements } from './storage-requirements.js';

/**
 * What one released version of a container supports: its options and their settings (which of them are secret), the
 * application roles it declares, the storage it needs and the endpoints it serves. Immutable; build it with
 * `ComponentDescriptorBuilder` or decode it with `ComponentDescriptorCodec`.
 */
export class ComponentDescriptor
{
    public readonly Options: readonly OptionDescriptor[];
    public readonly Roles: readonly RoleDescriptor[];

    public constructor(
        public readonly Name: string,
        public readonly Version: string,
        options: readonly OptionDescriptor[],
        roles: readonly RoleDescriptor[],
        public readonly Storage: StorageRequirements,
        public readonly Endpoints: EndpointDescriptor,
    )
    {
        this.Options = Object.freeze([...options]);
        this.Roles = Object.freeze([...roles]);
        Object.freeze(this);
    }

    public Option(name: string): OptionDescriptor | undefined
    {
        return this.Options.find(option => option.Name === name);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return {
            [DescriptorKeys.Schema]: DescriptorKeys.SchemaVersion,
            [DescriptorKeys.Component]: this.Name,
            [DescriptorKeys.Version]: this.Version,
            [DescriptorKeys.Options]: this.Options.map(option => option.ToJson()),
            [DescriptorKeys.Roles]: this.Roles.map(role => role.ToJson()),
            [DescriptorKeys.Storage]: this.Storage.ToJson(),
            [DescriptorKeys.Endpoints]: this.Endpoints.ToJson(),
        };
    }

    /** The canonical JSON text (sorted keys, no whitespace): what the image carries and the digest covers. */
    public ToCanonicalJson(): string
    {
        return CanonicalJson.Stringify(this.ToJson());
    }

    /** `sha256:<hex>` of the canonical JSON text. */
    public ContentDigest(): string
    {
        return CanonicalJson.Digest(this.ToJson());
    }
}
