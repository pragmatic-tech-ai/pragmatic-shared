import { JsonValue } from './canonical-json.js';
import { ComponentDescriptor } from './component-descriptor.js';
import { ComponentDescriptorError } from './component-descriptor-error.js';
import { EndpointDescriptor, HealthEndpoint, PortDescriptor } from './endpoint-descriptor.js';
import { OptionDescriptor } from './option-descriptor.js';
import { RoleDescriptor } from './role-descriptor.js';
import { SettingDescriptor } from './setting-descriptor.js';
import { SettingType, SettingValues } from './setting-type.js';
import { StorageRequirements } from './storage-requirements.js';

/** Declares one setting; `ComponentDescriptorBuilder.Build` checks the declaration. */
export class SettingBuilder
{
    private required = false;
    private secret = false;
    private defaultValue: JsonValue | undefined;
    private description = '';
    private minimum: number | undefined;
    private maximum: number | undefined;

    public constructor(
        public readonly Name: string,
        public readonly Type: SettingType,
    )
    {
    }

    public Required(): this
    {
        this.required = true;
        return this;
    }

    /** The value lives in the realm's secrets home; a configuration holds only a `SecretReference` to it. */
    public Secret(): this
    {
        this.secret = true;
        return this;
    }

    public Default(value: JsonValue): this
    {
        this.defaultValue = value;
        return this;
    }

    public Description(text: string): this
    {
        this.description = text;
        return this;
    }

    /** The smallest value an integer setting accepts (inclusive). */
    public Minimum(value: number): this
    {
        this.minimum = value;
        return this;
    }

    /** The largest value an integer setting accepts (inclusive). */
    public Maximum(value: number): this
    {
        this.maximum = value;
        return this;
    }

    public Build(): SettingDescriptor
    {
        return new SettingDescriptor(this.Name, this.Type, this.required, this.secret, SettingBuilder.Frozen(this.defaultValue), this.description, this.minimum, this.maximum);
    }

    private static Frozen(value: JsonValue | undefined): JsonValue | undefined
    {
        return Array.isArray(value) ? Object.freeze([...value]) as JsonValue : value;
    }
}

/** Declares one option and its settings. */
export class OptionBuilder
{
    private readonly settings: SettingBuilder[] = [];

    public constructor(
        public readonly Name: string,
        public readonly Description: string,
    )
    {
    }

    public Setting(name: string, type: SettingType, configure?: (setting: SettingBuilder) => SettingBuilder): this
    {
        const setting = new SettingBuilder(name, type);
        configure?.(setting);
        this.settings.push(setting);
        return this;
    }

    public Build(): OptionDescriptor
    {
        return new OptionDescriptor(this.Name, this.Description, this.settings.map(setting => setting.Build()));
    }
}

/**
 * Fluent declaration of a `ComponentDescriptor`. `Build` enforces the rules: well-formed names and version, unique
 * option, setting, role and port names, no default on a secret or required setting, secret settings are strings,
 * defaults of the setting's type, bounds only on integer settings (safe integers, the minimum at most the maximum, the
 * default between them), ports in range and a health endpoint on a declared port.
 */
export class ComponentDescriptorBuilder
{
    private static readonly ComponentName = /^[a-z][a-z0-9-]*$/;
    private static readonly MemberName = /^[a-z][A-Za-z0-9]*$/;
    private static readonly RoleName = /^[a-z][A-Za-z0-9.-]*$/;
    private static readonly PortName = /^[a-z][a-z0-9-]*$/;
    private static readonly SemanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
    private static readonly HealthPath = /^\/[^\s?#]*$/;
    private static readonly MinPort = 1;
    private static readonly MaxPort = 65535;
    private static readonly SettingPathSeparator = '.';

    private static readonly InvalidComponentName = "invalid component name '{0}' (lowercase letters, digits and '-')";
    private static readonly InvalidVersion = "invalid version '{0}' (semantic version expected)";
    private static readonly InvalidOptionName = "invalid option name '{0}'";
    private static readonly InvalidSettingName = "invalid setting name '{0}'";
    private static readonly InvalidRoleName = "invalid role name '{0}'";
    private static readonly InvalidPortName = "invalid port name '{0}'";
    private static readonly InvalidPortNumber = "invalid port number {0} for port '{1}'";
    private static readonly DuplicateOption = "duplicate option '{0}'";
    private static readonly DuplicateSetting = "duplicate setting '{0}'";
    private static readonly DuplicateRole = "duplicate role '{0}'";
    private static readonly DuplicatePort = "duplicate port '{0}'";
    private static readonly DuplicatePortNumber = 'duplicate port number {0}';
    private static readonly UnknownType = "setting '{0}' has an unknown type '{1}'";
    private static readonly SecretDefault = "secret setting '{0}' cannot have a default";
    private static readonly SecretNotString = "secret setting '{0}' must be of type string";
    private static readonly RequiredDefault = "required setting '{0}' cannot have a default";
    private static readonly InvalidDefault = "default of setting '{0}' is not a valid {1}";
    private static readonly BoundOnNonInteger = "setting '{0}' is not an integer: it cannot have a minimum or maximum";
    private static readonly MinimumNotSafe = "minimum of setting '{0}' is not a safe integer";
    private static readonly MaximumNotSafe = "maximum of setting '{0}' is not a safe integer";
    private static readonly MinimumAboveMaximum = "setting '{0}' has a minimum above its maximum";
    private static readonly DefaultOutOfBounds = "default of setting '{0}' is outside its minimum and maximum";
    private static readonly UnknownHealthPort = "health endpoint port '{0}' is not a declared port";
    private static readonly InvalidHealthPath = "invalid health path '{0}' (an absolute path expected)";

    private readonly options: OptionBuilder[] = [];
    private readonly roles: RoleDescriptor[] = [];
    private readonly ports: PortDescriptor[] = [];
    private postgres = false;
    private health: HealthEndpoint | undefined;

    public constructor(
        private readonly name: string,
        private readonly version: string,
    )
    {
    }

    public Option(name: string, description: string, configure: (option: OptionBuilder) => OptionBuilder): this
    {
        const option = new OptionBuilder(name, description);
        configure(option);
        this.options.push(option);
        return this;
    }

    public Role(name: string, description: string): this
    {
        this.roles.push(new RoleDescriptor(name, description));
        return this;
    }

    /** The component needs a Postgres database of its own. */
    public Postgres(): this
    {
        this.postgres = true;
        return this;
    }

    public Port(name: string, number: number): this
    {
        this.ports.push(new PortDescriptor(name, number));
        return this;
    }

    public Health(port: string, path: string): this
    {
        this.health = new HealthEndpoint(port, path);
        return this;
    }

    public Build(): ComponentDescriptor
    {
        ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.ComponentName.test(this.name), ComponentDescriptorBuilder.InvalidComponentName, this.name);
        ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.SemanticVersion.test(this.version), ComponentDescriptorBuilder.InvalidVersion, this.version);
        const options = this.BuildOptions();
        this.CheckRoles();
        this.CheckEndpoints();
        return new ComponentDescriptor(this.name, this.version, options, this.roles, new StorageRequirements(this.postgres), new EndpointDescriptor(this.ports, this.health));
    }

    private BuildOptions(): OptionDescriptor[]
    {
        const names = new Set<string>();
        return this.options.map(builder =>
        {
            const option = builder.Build();
            ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.MemberName.test(option.Name), ComponentDescriptorBuilder.InvalidOptionName, option.Name);
            ComponentDescriptorBuilder.Check(!names.has(option.Name), ComponentDescriptorBuilder.DuplicateOption, option.Name);
            names.add(option.Name);
            ComponentDescriptorBuilder.CheckSettings(option);
            return option;
        });
    }

    private static CheckSettings(option: OptionDescriptor): void
    {
        const names = new Set<string>();
        for (const setting of option.Settings)
        {
            const path = option.Name + ComponentDescriptorBuilder.SettingPathSeparator + setting.Name;
            ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.MemberName.test(setting.Name), ComponentDescriptorBuilder.InvalidSettingName, setting.Name);
            ComponentDescriptorBuilder.Check(!names.has(setting.Name), ComponentDescriptorBuilder.DuplicateSetting, path);
            names.add(setting.Name);
            ComponentDescriptorBuilder.Check(SettingValues.IsType(setting.Type), ComponentDescriptorBuilder.UnknownType, path, setting.Type);
            if (setting.Secret)
            {
                ComponentDescriptorBuilder.Check(setting.Type === SettingType.String, ComponentDescriptorBuilder.SecretNotString, path);
                ComponentDescriptorBuilder.Check(setting.Default === undefined, ComponentDescriptorBuilder.SecretDefault, path);
            }
            if (setting.Default !== undefined)
            {
                ComponentDescriptorBuilder.Check(!setting.Required, ComponentDescriptorBuilder.RequiredDefault, path);
                ComponentDescriptorBuilder.Check(SettingValues.Accepts(setting.Type, setting.Default), ComponentDescriptorBuilder.InvalidDefault, path, setting.Type);
            }
            ComponentDescriptorBuilder.CheckBounds(setting, path);
        }
    }

    private static CheckBounds(setting: SettingDescriptor, path: string): void
    {
        const B = ComponentDescriptorBuilder;
        if (setting.Minimum === undefined && setting.Maximum === undefined) return;
        B.Check(setting.Type === SettingType.Integer, B.BoundOnNonInteger, path);
        B.Check(setting.Minimum === undefined || Number.isSafeInteger(setting.Minimum), B.MinimumNotSafe, path);
        B.Check(setting.Maximum === undefined || Number.isSafeInteger(setting.Maximum), B.MaximumNotSafe, path);
        B.Check(setting.Minimum === undefined || setting.Maximum === undefined || setting.Minimum <= setting.Maximum, B.MinimumAboveMaximum, path);
        B.Check(setting.Default === undefined || SettingValues.Within(setting.Default, setting.Minimum, setting.Maximum), B.DefaultOutOfBounds, path);
    }

    private CheckRoles(): void
    {
        const names = new Set<string>();
        for (const role of this.roles)
        {
            ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.RoleName.test(role.Name), ComponentDescriptorBuilder.InvalidRoleName, role.Name);
            ComponentDescriptorBuilder.Check(!names.has(role.Name), ComponentDescriptorBuilder.DuplicateRole, role.Name);
            names.add(role.Name);
        }
    }

    private CheckEndpoints(): void
    {
        const names = new Set<string>();
        const numbers = new Set<number>();
        for (const port of this.ports)
        {
            ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.PortName.test(port.Name), ComponentDescriptorBuilder.InvalidPortName, port.Name);
            const inRange = Number.isInteger(port.Number) && port.Number >= ComponentDescriptorBuilder.MinPort && port.Number <= ComponentDescriptorBuilder.MaxPort;
            ComponentDescriptorBuilder.Check(inRange, ComponentDescriptorBuilder.InvalidPortNumber, port.Number, port.Name);
            ComponentDescriptorBuilder.Check(!names.has(port.Name), ComponentDescriptorBuilder.DuplicatePort, port.Name);
            ComponentDescriptorBuilder.Check(!numbers.has(port.Number), ComponentDescriptorBuilder.DuplicatePortNumber, port.Number);
            names.add(port.Name);
            numbers.add(port.Number);
        }
        if (this.health !== undefined)
        {
            ComponentDescriptorBuilder.Check(names.has(this.health.Port), ComponentDescriptorBuilder.UnknownHealthPort, this.health.Port);
            ComponentDescriptorBuilder.Check(ComponentDescriptorBuilder.HealthPath.test(this.health.Path), ComponentDescriptorBuilder.InvalidHealthPath, this.health.Path);
        }
    }

    private static Check(condition: boolean, template: string, ...args: (string | number)[]): void
    {
        if (!condition) throw ComponentDescriptorError.Of(template, ...args);
    }
}
