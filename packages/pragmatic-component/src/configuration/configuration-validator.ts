import { ComponentDescriptor } from '../descriptor/component-descriptor.js';
import { OptionDescriptor } from '../descriptor/option-descriptor.js';
import { SettingDescriptor } from '../descriptor/setting-descriptor.js';
import { SettingValues } from '../descriptor/setting-type.js';
import { ConfigurationError, ConfigurationErrorCode } from './configuration-error.js';
import { ConfigurationKeys } from './configuration-keys.js';
import { ResolvedConfiguration, SettingValue } from './resolved-configuration.js';
import { SecretReference } from './secret-reference.js';

/** The outcome of validating one configuration document: every error found, and the resolved configuration if none. */
export class ConfigurationValidation
{
    public readonly Errors: readonly ConfigurationError[];

    public constructor(
        errors: readonly ConfigurationError[],
        public readonly Configuration: ResolvedConfiguration | undefined,
    )
    {
        this.Errors = Object.freeze([...errors]);
        Object.freeze(this);
    }

    public get Valid(): boolean
    {
        return this.Errors.length === 0;
    }
}

/** RFC 6901 JSON pointers for error paths. */
class JsonPointer
{
    private static readonly Separator = '/';
    private static readonly Tilde = /~/g;
    private static readonly Slash = /\//g;
    private static readonly EscapedTilde = '~0';
    private static readonly EscapedSlash = '~1';

    public static Of(...segments: string[]): string
    {
        return segments.map(segment => JsonPointer.Separator + segment.replace(JsonPointer.Tilde, JsonPointer.EscapedTilde).replace(JsonPointer.Slash, JsonPointer.EscapedSlash)).join('');
    }
}

/**
 * Validates configuration documents (`{ "options": { "<option>": { "<setting>": <value> } } }`) against the descriptor
 * of the component version they will run with. An option present in `options` is enabled. It reports unknown members,
 * options and settings, missing required settings of enabled options, values of the wrong type, integers outside the
 * setting's declared minimum or maximum, and any literal value in a secret setting (only a `SecretReference` is accepted there); a valid document resolves with defaults filled in.
 * Driven by the descriptor directly; `ConfigurationSchema` states the same rules as JSON Schema for other tools.
 */
export class ConfigurationValidator
{
    private static readonly Document = '';

    public constructor(
        public readonly Descriptor: ComponentDescriptor,
    )
    {
    }

    public Validate(document: unknown): ConfigurationValidation
    {
        const errors: ConfigurationError[] = [];
        const resolved = new Map<string, Map<string, SettingValue>>();
        if (!ConfigurationValidator.IsObject(document))
        {
            return new ConfigurationValidation([new ConfigurationError(ConfigurationValidator.Document, ConfigurationErrorCode.NotAnObject)], undefined);
        }
        for (const key of Object.keys(document))
        {
            if (key !== ConfigurationKeys.Options) errors.push(new ConfigurationError(JsonPointer.Of(key), ConfigurationErrorCode.UnknownProperty));
        }
        const options = document[ConfigurationKeys.Options];
        if (options === undefined)
        {
            errors.push(new ConfigurationError(JsonPointer.Of(ConfigurationKeys.Options), ConfigurationErrorCode.MissingRequired));
        }
        else if (!ConfigurationValidator.IsObject(options))
        {
            errors.push(new ConfigurationError(JsonPointer.Of(ConfigurationKeys.Options), ConfigurationErrorCode.NotAnObject));
        }
        else
        {
            this.ValidateOptions(options, errors, resolved);
        }
        return errors.length === 0
            ? new ConfigurationValidation(errors, new ResolvedConfiguration(this.InDescriptorOrder(resolved)))
            : new ConfigurationValidation(errors, undefined);
    }

    private ValidateOptions(options: Record<string, unknown>, errors: ConfigurationError[], resolved: Map<string, Map<string, SettingValue>>): void
    {
        for (const [name, settings] of Object.entries(options))
        {
            const option = this.Descriptor.Option(name);
            const path = [ConfigurationKeys.Options, name];
            if (option === undefined)
            {
                errors.push(new ConfigurationError(JsonPointer.Of(...path), ConfigurationErrorCode.UnknownOption));
            }
            else if (!ConfigurationValidator.IsObject(settings))
            {
                errors.push(new ConfigurationError(JsonPointer.Of(...path), ConfigurationErrorCode.NotAnObject));
            }
            else
            {
                resolved.set(name, ConfigurationValidator.ValidateSettings(option, settings, path, errors));
            }
        }
    }

    private static ValidateSettings(option: OptionDescriptor, settings: Record<string, unknown>, path: string[], errors: ConfigurationError[]): Map<string, SettingValue>
    {
        const given = new Map<string, SettingValue>();
        for (const [name, value] of Object.entries(settings))
        {
            const setting = option.Setting(name);
            const settingPath = JsonPointer.Of(...path, name);
            if (setting === undefined)
            {
                errors.push(new ConfigurationError(settingPath, ConfigurationErrorCode.UnknownSetting));
                continue;
            }
            const checked = ConfigurationValidator.Check(setting, value, settingPath, errors);
            if (checked !== undefined) given.set(name, checked);
        }
        const values = new Map<string, SettingValue>();
        for (const setting of option.Settings)
        {
            const value = given.get(setting.Name) ?? setting.Default as SettingValue | undefined;
            if (value !== undefined)
            {
                values.set(setting.Name, value);
            }
            else if (setting.Required && !(setting.Name in settings))
            {
                errors.push(new ConfigurationError(JsonPointer.Of(...path, setting.Name), ConfigurationErrorCode.MissingRequired));
            }
        }
        return values;
    }

    /** The value as the configuration holds it, or undefined after recording why it is refused. */
    private static Check(setting: SettingDescriptor, value: unknown, path: string, errors: ConfigurationError[]): SettingValue | undefined
    {
        if (setting.Secret)
        {
            if (typeof value !== 'string' || !SecretReference.LooksLikeReference(value))
            {
                errors.push(new ConfigurationError(path, ConfigurationErrorCode.LiteralSecret));
                return undefined;
            }
            const reference = SecretReference.TryParse(value);
            if (reference === undefined) errors.push(new ConfigurationError(path, ConfigurationErrorCode.InvalidSecretReference));
            return reference;
        }
        if (!SettingValues.Accepts(setting.Type, value))
        {
            errors.push(new ConfigurationError(path, ConfigurationErrorCode.WrongType));
            return undefined;
        }
        if (setting.Minimum !== undefined && !SettingValues.Within(value, setting.Minimum, undefined))
        {
            errors.push(new ConfigurationError(path, ConfigurationErrorCode.BelowMinimum, setting.Minimum, setting.Maximum));
            return undefined;
        }
        if (setting.Maximum !== undefined && !SettingValues.Within(value, undefined, setting.Maximum))
        {
            errors.push(new ConfigurationError(path, ConfigurationErrorCode.AboveMaximum, setting.Minimum, setting.Maximum));
            return undefined;
        }
        return Array.isArray(value) ? Object.freeze([...value as string[]]) : value as SettingValue;
    }

    private InDescriptorOrder(resolved: Map<string, Map<string, SettingValue>>): Map<string, Map<string, SettingValue>>
    {
        const ordered = new Map<string, Map<string, SettingValue>>();
        for (const option of this.Descriptor.Options)
        {
            const values = resolved.get(option.Name);
            if (values !== undefined) ordered.set(option.Name, values);
        }
        return ordered;
    }

    private static IsObject(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
