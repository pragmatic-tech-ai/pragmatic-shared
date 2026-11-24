import { CanonicalJson, JsonValue } from './canonical-json.js';
import { ComponentDescriptor } from './component-descriptor.js';
import { ComponentDescriptorBuilder, OptionBuilder, SettingBuilder } from './component-descriptor-builder.js';
import { ComponentDescriptorError } from './component-descriptor-error.js';
import { DescriptorKeys } from './descriptor-keys.js';
import { SettingType } from './setting-type.js';

/** Strict reading of one JSON object of the descriptor: only the expected keys, each of the expected JSON type. */
class DescriptorObject
{
    private static readonly NotAnObject = "descriptor member '{0}' must be an object";
    private static readonly UnknownKey = "unknown key '{0}' in descriptor member '{1}'";
    private static readonly NotAString = "descriptor member '{0}' must be a string";
    private static readonly NotABoolean = "descriptor member '{0}' must be a boolean";
    private static readonly NotANumber = "descriptor member '{0}' must be a number";
    private static readonly NotAnArray = "descriptor member '{0}' must be an array";
    private static readonly Root = '$';

    private constructor(
        private readonly members: Record<string, unknown>,
        private readonly where: string,
    )
    {
    }

    public static Read(value: unknown, keys: readonly string[]): DescriptorObject
    {
        return DescriptorObject.Of(value, DescriptorObject.Root, keys);
    }

    public static Of(value: unknown, where: string, keys: readonly string[]): DescriptorObject
    {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw ComponentDescriptorError.Of(DescriptorObject.NotAnObject, where);
        const members = value as Record<string, unknown>;
        for (const key of Object.keys(members))
        {
            if (!keys.includes(key)) throw ComponentDescriptorError.Of(DescriptorObject.UnknownKey, key, where);
        }
        return new DescriptorObject(members, where);
    }

    public Has(key: string): boolean
    {
        return this.members[key] !== undefined;
    }

    public Raw(key: string): unknown
    {
        return this.members[key];
    }

    public String(key: string): string
    {
        const value = this.members[key];
        if (typeof value !== 'string') throw ComponentDescriptorError.Of(DescriptorObject.NotAString, key);
        return value;
    }

    public Boolean(key: string): boolean
    {
        const value = this.members[key];
        if (typeof value !== 'boolean') throw ComponentDescriptorError.Of(DescriptorObject.NotABoolean, key);
        return value;
    }

    public Number(key: string): number
    {
        const value = this.members[key];
        if (typeof value !== 'number') throw ComponentDescriptorError.Of(DescriptorObject.NotANumber, key);
        return value;
    }

    public Array(key: string): unknown[]
    {
        const value = this.members[key];
        if (!Array.isArray(value)) throw ComponentDescriptorError.Of(DescriptorObject.NotAnArray, key);
        return value;
    }

    public Object(key: string, keys: readonly string[]): DescriptorObject
    {
        return DescriptorObject.Of(this.members[key], key, keys);
    }
}

/**
 * The component descriptor's JSON codec (schema 1). `Serialize` writes canonical JSON (the form the digest covers);
 * `Decode` / `Parse` read any JSON layout strictly — unknown keys are refused, since they would not survive re-encoding
 * and the digest of the decoded descriptor would not match the document's — and apply every builder rule.
 */
export class ComponentDescriptorCodec
{
    private static readonly RootKeys = [DescriptorKeys.Schema, DescriptorKeys.Component, DescriptorKeys.Version, DescriptorKeys.Options, DescriptorKeys.Roles, DescriptorKeys.Storage, DescriptorKeys.Endpoints];
    private static readonly OptionKeys = [DescriptorKeys.Name, DescriptorKeys.Description, DescriptorKeys.Settings];
    private static readonly SettingKeys = [DescriptorKeys.Name, DescriptorKeys.Type, DescriptorKeys.Required, DescriptorKeys.Secret, DescriptorKeys.Default, DescriptorKeys.Description, DescriptorKeys.Minimum, DescriptorKeys.Maximum];
    private static readonly RoleKeys = [DescriptorKeys.Name, DescriptorKeys.Description];
    private static readonly StorageKeys = [DescriptorKeys.Postgres];
    private static readonly EndpointKeys = [DescriptorKeys.Ports, DescriptorKeys.Health];
    private static readonly PortKeys = [DescriptorKeys.Name, DescriptorKeys.Port];
    private static readonly HealthKeys = [DescriptorKeys.Port, DescriptorKeys.Path];
    private static readonly NotJson = 'component descriptor is not valid JSON: {0}';
    private static readonly UnsupportedSchema = 'unsupported component descriptor schema {0} (expected {1})';

    public static Serialize(descriptor: ComponentDescriptor): string
    {
        return CanonicalJson.Stringify(descriptor.ToJson());
    }

    public static Parse(text: string): ComponentDescriptor
    {
        let value: unknown;
        try
        {
            value = JSON.parse(text);
        }
        catch (error)
        {
            throw ComponentDescriptorError.Of(ComponentDescriptorCodec.NotJson, error instanceof Error ? error.message : String(error));
        }
        return ComponentDescriptorCodec.Decode(value);
    }

    public static Decode(value: unknown): ComponentDescriptor
    {
        const root = DescriptorObject.Read(value, ComponentDescriptorCodec.RootKeys);
        const schema = root.Number(DescriptorKeys.Schema);
        if (schema !== DescriptorKeys.SchemaVersion)
        {
            throw ComponentDescriptorError.Of(ComponentDescriptorCodec.UnsupportedSchema, schema, DescriptorKeys.SchemaVersion);
        }
        const builder = new ComponentDescriptorBuilder(root.String(DescriptorKeys.Component), root.String(DescriptorKeys.Version));
        for (const item of root.Array(DescriptorKeys.Options))
        {
            const option = DescriptorObject.Of(item, DescriptorKeys.Options, ComponentDescriptorCodec.OptionKeys);
            const settings = option.Array(DescriptorKeys.Settings);
            builder.Option(option.String(DescriptorKeys.Name), option.String(DescriptorKeys.Description), declared => ComponentDescriptorCodec.DecodeSettings(declared, settings));
        }
        for (const item of root.Array(DescriptorKeys.Roles))
        {
            const role = DescriptorObject.Of(item, DescriptorKeys.Roles, ComponentDescriptorCodec.RoleKeys);
            builder.Role(role.String(DescriptorKeys.Name), role.String(DescriptorKeys.Description));
        }
        if (root.Object(DescriptorKeys.Storage, ComponentDescriptorCodec.StorageKeys).Boolean(DescriptorKeys.Postgres)) builder.Postgres();
        ComponentDescriptorCodec.DecodeEndpoints(builder, root.Object(DescriptorKeys.Endpoints, ComponentDescriptorCodec.EndpointKeys));
        return builder.Build();
    }

    private static DecodeSettings(option: OptionBuilder, settings: unknown[]): OptionBuilder
    {
        for (const item of settings)
        {
            const setting = DescriptorObject.Of(item, DescriptorKeys.Settings, ComponentDescriptorCodec.SettingKeys);
            const required = setting.Boolean(DescriptorKeys.Required);
            const secret = setting.Boolean(DescriptorKeys.Secret);
            const description = setting.String(DescriptorKeys.Description);
            const minimum = setting.Has(DescriptorKeys.Minimum) ? setting.Number(DescriptorKeys.Minimum) : undefined;
            const maximum = setting.Has(DescriptorKeys.Maximum) ? setting.Number(DescriptorKeys.Maximum) : undefined;
            option.Setting(setting.String(DescriptorKeys.Name), setting.String(DescriptorKeys.Type) as SettingType, (declared: SettingBuilder) =>
            {
                if (required) declared.Required();
                if (secret) declared.Secret();
                if (setting.Has(DescriptorKeys.Default)) declared.Default(setting.Raw(DescriptorKeys.Default) as JsonValue);
                if (minimum !== undefined) declared.Minimum(minimum);
                if (maximum !== undefined) declared.Maximum(maximum);
                return declared.Description(description);
            });
        }
        return option;
    }

    private static DecodeEndpoints(builder: ComponentDescriptorBuilder, endpoints: DescriptorObject): void
    {
        for (const item of endpoints.Array(DescriptorKeys.Ports))
        {
            const port = DescriptorObject.Of(item, DescriptorKeys.Ports, ComponentDescriptorCodec.PortKeys);
            builder.Port(port.String(DescriptorKeys.Name), port.Number(DescriptorKeys.Port));
        }
        if (endpoints.Has(DescriptorKeys.Health))
        {
            const health = endpoints.Object(DescriptorKeys.Health, ComponentDescriptorCodec.HealthKeys);
            builder.Health(health.String(DescriptorKeys.Port), health.String(DescriptorKeys.Path));
        }
    }
}
