import { CanonicalJson, JsonValue } from '../descriptor/canonical-json.js';
import { ComponentDescriptor } from '../descriptor/component-descriptor.js';
import { OptionDescriptor } from '../descriptor/option-descriptor.js';
import { SettingDescriptor } from '../descriptor/setting-descriptor.js';
import { SettingType, SettingValues } from '../descriptor/setting-type.js';
import { ConfigurationKeys } from './configuration-keys.js';
import { SecretReference } from './secret-reference.js';

type SchemaObject = Record<string, JsonValue>;

/**
 * The JSON Schema (draft 2020-12) of a component version's configuration documents, derived from its descriptor:
 * closed objects for the document, its options and each option's settings; required settings; each setting type; and
 * a secret setting accepts only a secret reference. For editors and other tools — `ConfigurationValidator` enforces the
 * same rules from the descriptor directly.
 */
export class ConfigurationSchema
{
    public static readonly Dialect = 'https://json-schema.org/draft/2020-12/schema';

    private static readonly IdPrefix = 'urn:pragmatic:component:';
    private static readonly IdSeparator = ':';
    private static readonly IdSuffix = ':configuration';
    private static readonly SecretReferenceDefinition = 'secretReference';
    private static readonly SecretReferencePointer = '#/$defs/secretReference';
    private static readonly SecretReferenceDescription = 'A reference into the realm secrets home: secret:<store>/<name>[@<version>]';

    private static readonly SchemaKey = '$schema';
    private static readonly IdKey = '$id';
    private static readonly DefsKey = '$defs';
    private static readonly RefKey = '$ref';
    private static readonly TitleKey = 'title';
    private static readonly TypeKey = 'type';
    private static readonly PropertiesKey = 'properties';
    private static readonly AdditionalPropertiesKey = 'additionalProperties';
    private static readonly RequiredKey = 'required';
    private static readonly DescriptionKey = 'description';
    private static readonly DefaultKey = 'default';
    private static readonly FormatKey = 'format';
    private static readonly PatternKey = 'pattern';
    private static readonly ItemsKey = 'items';

    private static readonly ObjectType = 'object';
    private static readonly StringType = 'string';
    private static readonly IntegerType = 'integer';
    private static readonly BooleanType = 'boolean';
    private static readonly ArrayType = 'array';
    private static readonly UriFormat = 'uri';

    public constructor(
        public readonly Descriptor: ComponentDescriptor,
    )
    {
    }

    public get Id(): string
    {
        return ConfigurationSchema.IdPrefix + this.Descriptor.Name + ConfigurationSchema.IdSeparator + this.Descriptor.Version + ConfigurationSchema.IdSuffix;
    }

    public ToJson(): SchemaObject
    {
        const options: SchemaObject = {};
        for (const option of this.Descriptor.Options)
        {
            options[option.Name] = ConfigurationSchema.OptionSchema(option);
        }
        const schema: SchemaObject = {
            [ConfigurationSchema.SchemaKey]: ConfigurationSchema.Dialect,
            [ConfigurationSchema.IdKey]: this.Id,
            [ConfigurationSchema.TitleKey]: this.Descriptor.Name + ' ' + this.Descriptor.Version,
            [ConfigurationSchema.TypeKey]: ConfigurationSchema.ObjectType,
            [ConfigurationSchema.PropertiesKey]: {
                [ConfigurationKeys.Options]: {
                    [ConfigurationSchema.TypeKey]: ConfigurationSchema.ObjectType,
                    [ConfigurationSchema.PropertiesKey]: options,
                    [ConfigurationSchema.AdditionalPropertiesKey]: false,
                },
            },
            [ConfigurationSchema.RequiredKey]: [ConfigurationKeys.Options],
            [ConfigurationSchema.AdditionalPropertiesKey]: false,
        };
        if (this.Descriptor.Options.some(option => option.Settings.some(setting => setting.Secret)))
        {
            schema[ConfigurationSchema.DefsKey] = {
                [ConfigurationSchema.SecretReferenceDefinition]: {
                    [ConfigurationSchema.TypeKey]: ConfigurationSchema.StringType,
                    [ConfigurationSchema.PatternKey]: SecretReference.Pattern,
                    [ConfigurationSchema.DescriptionKey]: ConfigurationSchema.SecretReferenceDescription,
                },
            };
        }
        return schema;
    }

    public ToCanonicalJson(): string
    {
        return CanonicalJson.Stringify(this.ToJson());
    }

    private static OptionSchema(option: OptionDescriptor): SchemaObject
    {
        const properties: SchemaObject = {};
        for (const setting of option.Settings)
        {
            properties[setting.Name] = ConfigurationSchema.SettingSchema(setting);
        }
        const schema: SchemaObject = { [ConfigurationSchema.TypeKey]: ConfigurationSchema.ObjectType };
        ConfigurationSchema.Describe(schema, option.Description);
        schema[ConfigurationSchema.PropertiesKey] = properties;
        const required = option.Settings.filter(setting => setting.Required).map(setting => setting.Name);
        if (required.length > 0) schema[ConfigurationSchema.RequiredKey] = required;
        schema[ConfigurationSchema.AdditionalPropertiesKey] = false;
        return schema;
    }

    private static SettingSchema(setting: SettingDescriptor): SchemaObject
    {
        const schema = setting.Secret
            ? { [ConfigurationSchema.RefKey]: ConfigurationSchema.SecretReferencePointer }
            : ConfigurationSchema.TypeSchema(setting.Type);
        if (setting.Default !== undefined) schema[ConfigurationSchema.DefaultKey] = setting.Default;
        ConfigurationSchema.Describe(schema, setting.Description);
        return schema;
    }

    private static TypeSchema(type: SettingType): SchemaObject
    {
        switch (type)
        {
            case SettingType.String:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.StringType };
            case SettingType.Integer:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.IntegerType };
            case SettingType.Boolean:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.BooleanType };
            case SettingType.Url:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.StringType, [ConfigurationSchema.FormatKey]: ConfigurationSchema.UriFormat };
            case SettingType.Duration:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.StringType, [ConfigurationSchema.PatternKey]: SettingValues.DurationPattern };
            case SettingType.List:
                return { [ConfigurationSchema.TypeKey]: ConfigurationSchema.ArrayType, [ConfigurationSchema.ItemsKey]: { [ConfigurationSchema.TypeKey]: ConfigurationSchema.StringType } };
        }
    }

    private static Describe(schema: SchemaObject, description: string): void
    {
        if (description.length > 0) schema[ConfigurationSchema.DescriptionKey] = description;
    }
}
